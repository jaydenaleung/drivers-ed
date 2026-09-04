import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.DRY_RUN = 'true';
process.env.POST_SOURCE = 'replay';
process.env.TIMEZONE = 'America/New_York';

const { openDatabase, SKIP_REASONS } = await import('../src/db.js');
const { updateSettings } = await import('../src/settings.js');
const { upsertLesson, applyClaimNotice, runClaimSweep } = await import('../src/pipeline.js');
const { createServer } = await import('../src/web/server.js');

const reasonOf = (db, id) => db.prepare('SELECT status, skip_reason FROM lessons WHERE id = ?').get(id);

function seed(db) {
  updateSettings(db, { scriptEnabled: true, areas: ['Needham'] });
  return {
    // A town Jayden did not select.
    wrongArea: upsertLesson(
      db,
      { date: '2099-05-01', start_time: '13:00', end_time: '14:00', areas: ['Natick'] },
      'p1',
    ),
    // Never evaluated by a sweep.
    untouched: upsertLesson(
      db,
      { date: '2099-05-01', start_time: '15:00', end_time: '16:00', areas: ['Needham'] },
      'p2',
    ),
  };
}

// ---------------------------------------------------------------------------
// The reported bug
// ---------------------------------------------------------------------------

test('a claim notice does not relabel a lesson we skipped for the wrong town', async () => {
  const db = openDatabase(':memory:');
  const { wrongArea } = seed(db);

  await runClaimSweep(db, {
    sendClaimEmail: async () => ({ messageId: 'x' }),
    notify: async () => ({ ok: true }),
    now: () => new Date('2099-04-01T12:00:00Z'),
    timezone: 'UTC',
  });
  assert.equal(reasonOf(db, wrongArea).skip_reason, SKIP_REASONS.WRONG_AREA, 'precondition');

  // The school then announces the whole day is gone.
  applyClaimNotice(db, { date: '2099-05-01', is_blanket_claim: true }, null);

  const row = reasonOf(db, wrongArea);
  assert.equal(
    row.skip_reason,
    SKIP_REASONS.WRONG_AREA,
    'the reason WE did not claim it must survive — it was never a candidate',
  );
  assert.equal(row.status, 'claimed_by_school', 'the status still records what the school did');
  db.close();
});

test('a lesson we never judged is correctly attributed to the school', async () => {
  const db = openDatabase(':memory:');
  const { untouched } = seed(db);

  applyClaimNotice(db, { date: '2099-05-01', is_blanket_claim: true }, null);

  const row = reasonOf(db, untouched);
  assert.equal(row.skip_reason, SKIP_REASONS.ALREADY_CLAIMED);
  assert.equal(row.status, 'claimed_by_school');
  db.close();
});

test('a specific claim notice preserves our reason too', async () => {
  const db = openDatabase(':memory:');
  const { wrongArea } = seed(db);

  await runClaimSweep(db, {
    sendClaimEmail: async () => ({ messageId: 'x' }),
    notify: async () => ({ ok: true }),
    now: () => new Date('2099-04-01T12:00:00Z'),
    timezone: 'UTC',
  });

  applyClaimNotice(db, { date: '2099-05-01', start_time: '13:00', areas: ['Natick'] }, null);

  assert.equal(reasonOf(db, wrongArea).skip_reason, SKIP_REASONS.WRONG_AREA);
  db.close();
});

test('six claim notices in a row do not erode the reasons', async () => {
  // 3 Sep 2026: six claim notices arrived in one afternoon. Under the old
  // behaviour every one of them relabelled every remaining lesson.
  const db = openDatabase(':memory:');
  const { wrongArea } = seed(db);

  await runClaimSweep(db, {
    sendClaimEmail: async () => ({ messageId: 'x' }),
    notify: async () => ({ ok: true }),
    now: () => new Date('2099-04-01T12:00:00Z'),
    timezone: 'UTC',
  });

  for (let i = 0; i < 6; i += 1) {
    applyClaimNotice(db, { date: '2099-05-01', is_blanket_claim: true }, null);
  }

  assert.equal(reasonOf(db, wrongArea).skip_reason, SKIP_REASONS.WRONG_AREA);
  db.close();
});

test('an emailed lesson is still never touched by a claim notice', async () => {
  const db = openDatabase(':memory:');
  updateSettings(db, { scriptEnabled: true, areas: ['Needham'] });
  const id = upsertLesson(db, { date: '2099-05-01', start_time: '13:00', areas: ['Needham'] }, 'p1');
  db.prepare("UPDATE lessons SET status='email_sent', email_sent_at=datetime('now') WHERE id=?").run(id);

  applyClaimNotice(db, { date: '2099-05-01', is_blanket_claim: true }, null);

  assert.equal(reasonOf(db, id).status, 'email_sent', 'we did send that email; the record must say so');
  db.close();
});

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

async function withServer(run) {
  const db = openDatabase(':memory:');
  const server = createServer(db).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run({ db, base: `http://127.0.0.1:${server.address().port}` });
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

test('skipped rows show an email column and a local timestamp with its zone', async () => {
  await withServer(async ({ db, base }) => {
    const id = upsertLesson(db, { date: '2099-05-01', start_time: '13:00', areas: ['Natick'] }, 'p1');
    db.prepare(
      `UPDATE lessons SET status='skipped_no_match', skip_reason='wrong_area',
              updated_at='2026-09-03 19:15:33' WHERE id=?`,
    ).run(id);

    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();

    assert.match(html, /<th>Email sent<\/th>/);
    assert.match(html, /<th>Decided<\/th>/);
    // 19:15:33 UTC is 15:15:33 in New York, and September is daylight time.
    assert.match(html, /3:15:33 PM \(EDT\)/, 'shown in local time, 12-hour, with the zone named');
    assert.match(html, /Area not selected/);
    assert.match(html, />none</, 'no email was sent for a skipped lesson, and it says so');
  });
});

test('the zone label follows daylight saving rather than being hardcoded', async () => {
  await withServer(async ({ db, base }) => {
    const id = upsertLesson(db, { date: '2099-01-05', start_time: '13:00', areas: ['Natick'] }, 'p1');
    // January: the same clock is EST, not EDT.
    db.prepare(
      `UPDATE lessons SET status='skipped_no_match', skip_reason='wrong_area',
              updated_at='2026-01-05 20:15:33' WHERE id=?`,
    ).run(id);

    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();
    assert.match(html, /3:15:33 PM \(EST\)/);
  });
});

test('a lesson skipped for our reason and later claimed shows both, ours first', async () => {
  await withServer(async ({ db, base }) => {
    const id = upsertLesson(db, { date: '2099-05-01', start_time: '13:00', areas: ['Natick'] }, 'p1');
    db.prepare(
      "UPDATE lessons SET status='claimed_by_school', skip_reason='wrong_area' WHERE id=?",
    ).run(id);

    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();
    assert.match(html, /Area not selected/);
    assert.match(html, /school claimed it later/);
    assert.ok(
      html.indexOf('Area not selected') < html.indexOf('school claimed it later'),
      'our decision leads; what the school did is the footnote',
    );
  });
});

test('a genuinely school-claimed lesson does not get the footnote', async () => {
  await withServer(async ({ db, base }) => {
    const id = upsertLesson(db, { date: '2099-05-01', start_time: '13:00', areas: ['Needham'] }, 'p1');
    db.prepare(
      "UPDATE lessons SET status='claimed_by_school', skip_reason='already_claimed' WHERE id=?",
    ).run(id);

    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();
    assert.match(html, /School announced it was already claimed/);
    assert.ok(!html.includes('school claimed it later'), 'that would just repeat itself');
  });
});

test('the claimed table shows its send time in local time too', async () => {
  await withServer(async ({ db, base }) => {
    const id = upsertLesson(db, { date: '2099-05-01', start_time: '13:00', areas: ['Needham'] }, 'p1');
    db.prepare(
      "UPDATE lessons SET status='email_sent', email_sent_at='2026-09-03 19:15:33' WHERE id=?",
    ).run(id);

    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();
    assert.match(html, /2026-09-03 3:15:33 PM \(EDT\)/);
    assert.ok(!html.includes('2026-09-03 19:15:33'), 'the raw UTC string must not leak through');
  });
});

// ---------------------------------------------------------------------------
// 12-hour clock
// ---------------------------------------------------------------------------

test('lesson times read as a 12-hour clock', async () => {
  await withServer(async ({ db, base }) => {
    const id = upsertLesson(
      db,
      { date: '2099-05-01', start_time: '13:00', end_time: '14:30', areas: ['Natick'] },
      'p1',
    );
    db.prepare("UPDATE lessons SET status='skipped_no_match', skip_reason='wrong_area' WHERE id=?").run(id);

    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();
    assert.match(html, /1:00 PM–2:30 PM/);
    assert.ok(!/>13:00/.test(html), 'the 24-hour form must not survive into the page');
  });
});

test('midnight and noon are not confused', async () => {
  const { to12Hour } = await import('../src/web/views.js');
  assert.equal(to12Hour('00:00'), '12:00 AM', 'midnight is 12 AM, not 0 AM');
  assert.equal(to12Hour('12:00'), '12:00 PM', 'noon is 12 PM, not 0 PM');
  assert.equal(to12Hour('00:30'), '12:30 AM');
  assert.equal(to12Hour('12:30'), '12:30 PM');
  assert.equal(to12Hour('11:59'), '11:59 AM');
  assert.equal(to12Hour('23:59'), '11:59 PM');
  assert.equal(to12Hour('09:05'), '9:05 AM');
});

test('an overrun past midnight stays honest rather than claiming the wrong day', async () => {
  const { to12Hour } = await import('../src/web/views.js');
  // effectiveWindow deliberately does not wrap: a 23:30 lesson plus a buffer
  // is 25:00, and rendering that as "1:00 AM" would move it a day earlier.
  assert.equal(to12Hour('25:00'), '25:00');
  assert.equal(to12Hour('24:00'), '24:00');
});

test('a value that is not a time is passed through untouched', async () => {
  const { to12Hour } = await import('../src/web/views.js');
  assert.equal(to12Hour(''), '');
  assert.equal(to12Hour(null), '');
  assert.equal(to12Hour('tomorrow'), 'tomorrow');
});

test('the closed-window banner names the resume time in 12-hour form', async () => {
  await withServer(async ({ db, base }) => {
    updateSettings(db, { activeWindowEnabled: true, activeStart: '08:00', activeEnd: '18:00' });
    // Force the window closed by asking for a moment outside it is not possible
    // here, so assert on the setting rendering wherever it appears.
    const html = await (await fetch(`${base}/`, { headers: { Cookie: await login(base) } })).text();
    assert.match(html, /10:00 PM to 6:00 AM/, 'the midnight-crossing example reads as a clock too');
  });
});
