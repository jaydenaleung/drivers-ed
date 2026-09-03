import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

process.env.DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.DRY_RUN = 'true';
process.env.POST_SOURCE = 'replay';

const { openDatabase, SKIP_REASONS } = await import('../src/db.js');
const { getSettings, updateSettings } = await import('../src/settings.js');
const { evaluateLesson } = await import('../src/matcher.js');
const { upsertLesson, runClaimSweep } = await import('../src/pipeline.js');
const { createServer } = await import('../src/web/server.js');

const lesson = (over = {}) => ({
  id: 1,
  lesson_date: '2099-05-01',
  start_time: '13:00',
  end_time: '14:00',
  areas: ['Needham'],
  status: 'open',
  email_sent_at: null,
  ...over,
});

const settings = (over = {}) => ({
  scriptEnabled: true,
  areas: ['Needham'],
  timeRangeStart: '09:00',
  timeRangeEnd: '21:00',
  dateRangeStart: null,
  dateRangeEnd: null,
  overrunBufferMinutes: 30,
  activeWindowEnabled: false,
  activeStart: '07:00',
  activeEnd: '21:00',
  ...over,
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('a lesson inside the active window is claimed as normal', () => {
  const v = evaluateLesson(lesson(), settings({ activeWindowEnabled: true }), 10 * 60);
  assert.equal(v.matches, true);
});

test('a lesson outside the active window is skipped with its own reason', () => {
  const v = evaluateLesson(lesson(), settings({ activeWindowEnabled: true }), 5 * 60);
  assert.equal(v.matches, false);
  assert.equal(v.skipReason, SKIP_REASONS.OUTSIDE_ACTIVE_HOURS);
});

test('the active window does nothing while it is switched off', () => {
  const v = evaluateLesson(lesson(), settings({ activeWindowEnabled: false }), 5 * 60);
  assert.equal(v.matches, true, 'an unticked window must not silently gate anything');
});

test('a caller that passes no clock is never gated by the window', () => {
  // evaluateLesson is used in places that have no business knowing the time.
  // Defaulting to null must mean "window not applicable", not "window closed".
  const v = evaluateLesson(lesson(), settings({ activeWindowEnabled: true }));
  assert.equal(v.matches, true);
});

test('being switched off outranks being outside active hours', () => {
  // Both are true here. Reporting "outside active hours" would send you looking
  // at the clock when the actual problem is the main toggle.
  const v = evaluateLesson(
    lesson(),
    settings({ scriptEnabled: false, activeWindowEnabled: true }),
    5 * 60,
  );
  assert.equal(v.skipReason, SKIP_REASONS.SCRIPT_OFF);
});

test('the window is checked before the criteria, so the reason is the real one', () => {
  const v = evaluateLesson(
    lesson({ areas: ['Natick'] }),
    settings({ activeWindowEnabled: true }),
    5 * 60,
  );
  assert.equal(v.skipReason, SKIP_REASONS.OUTSIDE_ACTIVE_HOURS, 'not wrong_area');
});

// ---------------------------------------------------------------------------
// The sweep — a skip must be recoverable when the window opens
// ---------------------------------------------------------------------------

test('a lesson skipped for being out of hours is claimed once the window opens', async () => {
  const db = openDatabase(':memory:');
  updateSettings(db, {
    scriptEnabled: true,
    areas: ['Needham'],
    activeWindowEnabled: true,
    activeStart: '07:00',
    activeEnd: '21:00',
  });

  const id = upsertLesson(
    db,
    { date: '2099-05-01', start_time: '13:00', end_time: '14:00', areas: ['Needham'] },
    'post-1',
  );

  const sent = [];
  const deps = {
    sendClaimEmail: async (lessons) => {
      sent.push(lessons);
      return { messageId: 'x' };
    },
    notify: async () => ({ ok: true }),
    timezone: 'UTC',
  };

  // 05:00 UTC — outside the window.
  await runClaimSweep(db, { ...deps, now: () => new Date('2099-05-01T05:00:00Z') });
  let row = db.prepare('SELECT status, skip_reason FROM lessons WHERE id = ?').get(id);
  assert.equal(row.skip_reason, SKIP_REASONS.OUTSIDE_ACTIVE_HOURS);
  assert.equal(sent.length, 0, 'no email may go out while the window is closed');

  // 10:00 UTC — inside it. The row must still be reachable, which is why the
  // skip status stays 'skipped_no_match' rather than anything terminal.
  assert.equal(row.status, 'skipped_no_match');
  await runClaimSweep(db, { ...deps, now: () => new Date('2099-05-01T10:00:00Z') });
  row = db.prepare('SELECT status FROM lessons WHERE id = ?').get(id);
  assert.equal(row.status, 'email_sent');
  assert.equal(sent.length, 1);

  db.close();
});

// ---------------------------------------------------------------------------
// Settings storage and validation
// ---------------------------------------------------------------------------

test('active hours round-trip through the database', () => {
  const db = openDatabase(':memory:');
  const saved = updateSettings(db, {
    activeWindowEnabled: true,
    activeStart: '06:30',
    activeEnd: '22:15',
  });
  assert.equal(saved.activeWindowEnabled, true);
  assert.equal(saved.activeStart, '06:30');
  assert.equal(getSettings(db).activeEnd, '22:15');
  db.close();
});

test('a window crossing midnight is accepted', () => {
  const db = openDatabase(':memory:');
  const saved = updateSettings(db, {
    activeWindowEnabled: true,
    activeStart: '22:00',
    activeEnd: '06:00',
  });
  assert.equal(saved.activeStart, '22:00');
  db.close();
});

test('an identical start and end is rejected with a usable message', () => {
  const db = openDatabase(':memory:');
  assert.throws(
    () => updateSettings(db, { activeWindowEnabled: true, activeStart: '09:00', activeEnd: '09:00' }),
    /Untick/,
  );
  db.close();
});

test('a malformed time is rejected and nothing is written', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => updateSettings(db, { activeWindowEnabled: true, activeStart: '25:00' }), /HH:MM/);
  assert.equal(getSettings(db).activeStart, '07:00', 'the stored value survives a rejected write');
  db.close();
});

test('omitting the new fields leaves them alone instead of blanking them', () => {
  const db = openDatabase(':memory:');
  updateSettings(db, { activeWindowEnabled: true, activeStart: '08:00', activeEnd: '20:00' });
  updateSettings(db, { areas: ['Dover'] });

  const s = getSettings(db);
  assert.equal(s.activeStart, '08:00');
  assert.equal(s.activeWindowEnabled, true);
  db.close();
});

// ---------------------------------------------------------------------------
// Migration — the database on the server predates these columns
// ---------------------------------------------------------------------------

test('a database created before active hours existed gains the columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drivers-ed-migrate-'));
  const file = path.join(dir, 'old.db');

  // Build the settings table exactly as the previous release created it.
  const old = new Database(file);
  old.exec(`
    CREATE TABLE settings (
      id                     INTEGER PRIMARY KEY CHECK (id = 1),
      script_enabled         INTEGER NOT NULL DEFAULT 0,
      areas                  TEXT    NOT NULL DEFAULT '[]',
      time_range_start       TEXT    NOT NULL DEFAULT '09:00',
      time_range_end         TEXT    NOT NULL DEFAULT '21:00',
      date_range_start       TEXT,
      date_range_end         TEXT,
      overrun_buffer_minutes INTEGER NOT NULL DEFAULT 30,
      updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO settings (id, script_enabled, areas) VALUES (1, 1, '["Needham"]');
  `);
  old.close();

  const db = openDatabase(file);
  const s = getSettings(db);

  assert.equal(s.activeWindowEnabled, false, 'an existing install must not start gating on upgrade');
  assert.equal(s.activeStart, '07:00');
  assert.equal(s.scriptEnabled, true, 'existing settings are preserved');
  assert.deepEqual(s.areas, ['Needham']);

  // And it must be idempotent — every restart runs the same migration.
  db.close();
  const again = openDatabase(file);
  assert.equal(getSettings(again).scriptEnabled, true);
  again.close();

  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

async function withServer(run) {
  const db = openDatabase(':memory:');
  const server = createServer(db).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ db, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

async function login(base) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'correct-horse-battery-staple' }),
    redirect: 'manual',
  });
  return res.headers.get('set-cookie')?.split(';')[0] ?? null;
}

test('the dashboard shows the capacity note and the active-hours controls', async () => {
  await withServer(async ({ base }) => {
    const cookie = await login(base);
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();

    assert.match(html, /Polling capacity/);
    assert.match(html, /Only run during these hours/);
    assert.match(html, /name="active_start"/);
    assert.match(html, /name="active_end"/);
    // With only the documented 15-minute cap in play, nothing binds.
    assert.match(html, /no X rate cap ever binds/);
  });
});

test('active hours can be saved from the dashboard', async () => {
  await withServer(async ({ base, db }) => {
    const cookie = await login(base);

    const res = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['script_enabled', '1'],
        ['areas', 'Needham'],
        ['time_range_start', '09:00'],
        ['time_range_end', '21:00'],
        ['overrun_buffer_minutes', '30'],
        ['active_window_enabled', '1'],
        ['active_start', '08:00'],
        ['active_end', '20:00'],
      ]),
    });

    assert.equal(res.status, 200);
    const s = getSettings(db);
    assert.equal(s.activeWindowEnabled, true);
    assert.equal(s.activeStart, '08:00');
    assert.equal(s.activeEnd, '20:00');

    // 12 hours requested, shown next to the inputs.
    const html = await res.text();
    assert.match(html, /12 h\/day/);
  });
});

test('unticking the window box switches it off', async () => {
  await withServer(async ({ base, db }) => {
    const cookie = await login(base);
    updateSettings(db, { activeWindowEnabled: true });

    await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['time_range_start', '09:00'],
        ['time_range_end', '21:00'],
        ['overrun_buffer_minutes', '30'],
        ['active_start', '08:00'],
        ['active_end', '20:00'],
      ]),
    });

    assert.equal(getSettings(db).activeWindowEnabled, false);
  });
});

test('a shortfall renders the red warning, and no shortfall renders none', async () => {
  await withServer(async ({ base, db }) => {
    const cookie = await login(base);
    const { STATE_KEYS, setState } = await import('../src/db.js');

    updateSettings(db, {
      activeWindowEnabled: true,
      activeStart: '07:00',
      activeEnd: '21:00', // 14 hours
    });

    const clean = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
    assert.ok(!clean.includes('class="bang"'), 'no warning while capacity is ample');

    // Now let X report a 24-hour cap tight enough to bind at this interval.
    setState(
      db,
      STATE_KEYS.RATE_CAPS,
      JSON.stringify([
        {
          id: 'app_24hour',
          label: 'App requests per 24 hours',
          limit: 2000,
          windowSeconds: 86400,
          source: 'observed',
        },
      ]),
    );

    const flagged = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();
    assert.match(flagged, /class="bang"/, 'the red ! must appear');
    assert.match(flagged, /more than the API can sustain/);
    assert.match(flagged, /measured from X/, 'the figure is labelled as measured, not documented');
  });
});
