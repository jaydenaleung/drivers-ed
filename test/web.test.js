import test from 'node:test';
import assert from 'node:assert/strict';

// Config is read from the environment at import time, so these must be set
// before the modules under test are dynamically imported below.
process.env.DASHBOARD_PASSWORD = 'correct-horse-battery-staple';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.DRY_RUN = 'true';
process.env.POST_SOURCE = 'replay';

const { openDatabase } = await import('../src/db.js');
const { updateSettings } = await import('../src/settings.js');
const { createServer } = await import('../src/web/server.js');
const { upsertLesson } = await import('../src/pipeline.js');

/** Boots the app on an ephemeral port and returns helpers bound to it. */
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

async function login(base, password = 'correct-horse-battery-staple') {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });
  return { res, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null };
}

test('the dashboard is not reachable without the password', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });
});

test('settings cannot be changed without the password', async () => {
  await withServer(async ({ base, db }) => {
    const res = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ script_enabled: '1' }),
      redirect: 'manual',
    });

    assert.equal(res.status, 302);
    const { getSettings } = await import('../src/settings.js');
    assert.equal(getSettings(db).scriptEnabled, false, 'the bot must not have been switched on');
  });
});

test('a wrong password is rejected and issues no cookie', async () => {
  await withServer(async ({ base }) => {
    const { res, cookie } = await login(base, 'hunter2');
    assert.equal(res.status, 401);
    assert.equal(cookie, null);
  });
});

test('the correct password issues an HttpOnly SameSite=Strict session cookie', async () => {
  await withServer(async ({ base }) => {
    const { res } = await login(base);
    assert.equal(res.status, 302);

    const raw = res.headers.get('set-cookie');
    assert.match(raw, /HttpOnly/);
    assert.match(raw, /SameSite=Strict/, 'SameSite=Strict is what blocks cross-site form posts');
  });
});

test('a forged session cookie is rejected', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/`, {
      headers: { Cookie: `de_session=${Date.now()}.deadbeef` },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');
  });
});

test('a logged-in session sees the dashboard and can save settings', async () => {
  await withServer(async ({ base, db }) => {
    const { cookie } = await login(base);

    const page = await fetch(`${base}/`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Needham Driving School/);
    assert.match(html, /Enable bot/);

    const save = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([
        ['script_enabled', '1'],
        ['areas', 'Needham'],
        ['areas', 'Dover'],
        ['time_range_start', '10:00'],
        ['time_range_end', '18:00'],
        ['date_range_start', ''],
        ['date_range_end', ''],
        ['overrun_buffer_minutes', '45'],
      ]),
    });

    assert.equal(save.status, 200);
    const { getSettings } = await import('../src/settings.js');
    const s = getSettings(db);
    assert.equal(s.scriptEnabled, true);
    assert.deepEqual(s.areas, ['Needham', 'Dover']);
    assert.equal(s.timeRangeStart, '10:00');
    assert.equal(s.overrunBufferMinutes, 45);
  });
});

test('invalid settings are rejected with a 400 and nothing is written', async () => {
  await withServer(async ({ base, db }) => {
    const { cookie } = await login(base);

    const save = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        time_range_start: '18:00',
        time_range_end: '10:00', // end before start
        overrun_buffer_minutes: '30',
      }),
    });

    assert.equal(save.status, 400);
    const { getSettings } = await import('../src/settings.js');
    assert.equal(getSettings(db).timeRangeStart, '09:00', 'original values survive');
  });
});

test('post text is escaped, not injected, when it reaches the page', async () => {
  await withServer(async ({ base, db }) => {
    updateSettings(db, { areas: ['Needham'] });
    upsertLesson(
      db,
      {
        date: '2099-01-01',
        start_time: '13:00',
        end_time: '14:00',
        areas: ['Needham'],
      },
      '<script>alert(1)</script>',
    );
    // Must be a status the dashboard actually renders, or nothing is exercised.
    db.prepare(
      `UPDATE lessons SET status = 'skipped_no_match',
                          skip_reason = '<img src=x onerror=alert(1)>',
                          areas = '["<b>Needham</b>"]'
        WHERE id = 1`,
    ).run();

    const { cookie } = await login(base);
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();

    assert.ok(!html.includes('<img src=x onerror'), 'raw HTML must not survive into the page');
    assert.match(html, /&lt;img src=x onerror/);
  });
});

test('/healthz is reachable without a password for uptime monitoring', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(!('password' in body) && !JSON.stringify(body).includes('correct-horse'));
  });
});

test('logging out invalidates the session', async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);

    const out = await fetch(`${base}/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  });
});

test('the enable checkbox is labelled by what it does, not by current state', async () => {
  await withServer(async ({ base }) => {
    const { cookie } = await login(base);
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text();

    assert.match(html, /Enable bot/, 'label must say what ticking it does');
    assert.match(html, /currently OFF/, 'current state shown separately');
    assert.ok(
      !/<label for="script_enabled"[^>]*>Bot is /.test(html),
      '"Bot is OFF" next to an unticked box reads as if ticking turns it off',
    );
  });
});

test('clearing skipped lessons lets an identical lesson be claimed again', async () => {
  await withServer(async ({ db, base }) => {
    const { upsertLesson } = await import('../src/pipeline.js');
    const id = upsertLesson(
      db,
      { date: '2099-03-03', start_time: '14:00', end_time: '15:00', areas: ['Needham'] },
      'test-post',
    );
    db.prepare("UPDATE lessons SET status='skipped_no_match', skip_reason='script_off' WHERE id=?").run(id);

    const { cookie } = await login(base);
    const res = await fetch(`${base}/lessons/clear-skipped`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n, 0);

    // The point of deleting rather than hiding: the dedupe key is free again.
    const again = upsertLesson(
      db,
      { date: '2099-03-03', start_time: '14:00', end_time: '15:00', areas: ['Needham'] },
      'real-post',
    );
    assert.equal(db.prepare('SELECT status FROM lessons WHERE id=?').get(again).status, 'open');
  });
});

test('clearing claimed records leaves an in-flight send alone', async () => {
  await withServer(async ({ db, base }) => {
    const { upsertLesson } = await import('../src/pipeline.js');
    const sent = upsertLesson(db, { date: '2099-03-03', start_time: '14:00', areas: ['Needham'] }, 'p1');
    const sending = upsertLesson(db, { date: '2099-03-04', start_time: '14:00', areas: ['Dover'] }, 'p2');
    db.prepare("UPDATE lessons SET status='email_sent', email_sent_at=datetime('now') WHERE id=?").run(sent);
    db.prepare("UPDATE lessons SET status='sending' WHERE id=?").run(sending);

    const { cookie } = await login(base);
    await fetch(`${base}/lessons/clear-claimed`, {
      method: 'POST',
      headers: { Cookie: cookie },
      redirect: 'manual',
    });

    assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n, 1);
    assert.equal(
      db.prepare('SELECT status FROM lessons').get().status,
      'sending',
      'deleting a sending row would drop the double-send guard mid-flight',
    );
  });
});

test('clearing requires the password', async () => {
  await withServer(async ({ db, base }) => {
    const { upsertLesson } = await import('../src/pipeline.js');
    upsertLesson(db, { date: '2099-03-03', start_time: '14:00', areas: ['Needham'] }, 'p1');
    db.prepare("UPDATE lessons SET status='skipped_no_match'").run();

    for (const path of ['/lessons/clear-skipped', '/lessons/clear-claimed']) {
      const res = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM lessons').get().n, 1, 'nothing deleted');
  });
});
