import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { updateSettings } from '../src/settings.js';
import { ingestPost, runClaimSweep, upsertLesson, applyClaimNotice, hydrate } from '../src/pipeline.js';
import { recentErrors } from '../src/errors.js';
import { parseWithRegex } from '../src/parser/regex.js';

const NOW = new Date('2026-07-27T14:00:00Z'); // 10:00 in America/New_York
const TZ = 'America/New_York';

/** A deps bundle that never touches the network. */
function makeDeps(overrides = {}) {
  const sent = [];
  const notified = [];

  return {
    sentEmails: sent,
    notifications: notified,
    deps: {
      // Regex-only parsing keeps these tests deterministic and offline.
      parsePost: async (text, opts) => ({
        parsed: parseWithRegex(text, opts),
        parser: 'regex',
        haikuError: null,
      }),
      sendClaimEmail: async (lesson) => {
        sent.push(lesson);
        return { messageId: `msg-${sent.length}`, accepted: ['info@example.com'] };
      },
      notify: async (lesson) => {
        notified.push(lesson);
        return { ok: true };
      },
      now: () => NOW,
      timezone: TZ,
      ...overrides,
    },
  };
}

function freshDb() {
  const db = openDatabase(':memory:');
  updateSettings(db, {
    scriptEnabled: true,
    areas: ['Needham', 'Wellesley'],
    timeRangeStart: '09:00',
    timeRangeEnd: '21:00',
    dateRangeStart: null,
    dateRangeEnd: null,
    overrunBufferMinutes: 30,
  });
  return db;
}

const OPENING_POST = {
  id: '1001',
  text: 'Lesson Open Today July 27th: 1-2 pm Needham/Wellesley Email info@needhamdrivingschool.com to claim this hour.',
  created_at: '2026-07-27T13:30:00Z',
};

const lessons = (db) => db.prepare('SELECT * FROM lessons ORDER BY id').all().map(hydrate);

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

test('an opening post creates exactly one lesson row', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  const result = await ingestPost(db, OPENING_POST, deps);
  assert.equal(result.status, 'lesson_recorded');

  const rows = lessons(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lesson_date, '2026-07-27');
  assert.equal(rows[0].start_time, '13:00');
  assert.equal(rows[0].status, 'open');
  assert.deepEqual(rows[0].areas, ['Needham', 'Wellesley']);
  assert.deepEqual(rows[0].source_post_ids, ['1001']);
});

test('the same post delivered twice is ignored the second time', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  const second = await ingestPost(db, OPENING_POST, deps);

  assert.equal(second.status, 'duplicate_post');
  assert.equal(lessons(db).length, 1);
});

test('the same lesson posted twice under different post IDs stays one row', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  await ingestPost(
    db,
    { ...OPENING_POST, id: '1002', text: 'Reminder! Lesson open today July 27th 1-2pm Needham/Wellesley — email to claim.' },
    deps,
  );

  const rows = lessons(db);
  assert.equal(rows.length, 1, 'dedupe_key collapses the reminder into the same lesson');
  assert.deepEqual(rows[0].source_post_ids, ['1001', '1002'], 'both posts are credited');
});

test('a non-lesson post creates nothing', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  const result = await ingestPost(
    db,
    { id: '2001', text: 'Congratulations to this week’s graduates!', created_at: '2026-07-27T12:00:00Z' },
    deps,
  );

  assert.equal(result.status, 'not_a_lesson');
  assert.equal(lessons(db).length, 0);
});

test('an opening with no parsable time is logged rather than silently dropped', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  const result = await ingestPost(
    db,
    { id: '2002', text: 'A lesson slot is open today in Needham — email to claim!', created_at: '2026-07-27T12:00:00Z' },
    deps,
  );

  assert.equal(result.status, 'incomplete_lesson');
  assert.equal(lessons(db).length, 0);
  assert.ok(
    recentErrors(db).some((e) => /no usable date\/time/.test(e.message)),
    'the near-miss must reach the error feed',
  );
});

test('"today" resolves to the POST date, not the processing date', async () => {
  const db = freshDb();
  // Process a post from the 26th while "now" is the 27th.
  const { deps } = makeDeps();
  await ingestPost(
    db,
    { id: '3001', text: 'Lesson open today 3-4 pm Needham. Email to claim.', created_at: '2026-07-26T18:00:00Z' },
    deps,
  );

  assert.equal(lessons(db)[0].lesson_date, '2026-07-26');
});

test('MIDNIGHT BOUNDARY: a late-night post keeps the date it was posted on', async () => {
  const db = freshDb();
  // Posted 11:55pm on the 27th (New York), polled at 12:01am on the 28th.
  const justAfterMidnight = new Date('2026-07-28T04:01:00Z');
  const { deps } = makeDeps({ now: () => justAfterMidnight });

  await ingestPost(
    db,
    {
      id: '3002',
      text: 'Lesson open today 1-2 pm Needham. Email to claim.',
      created_at: '2026-07-28T03:55:00Z', // 23:55 on the 27th in New York
    },
    deps,
  );

  assert.equal(
    lessons(db)[0].lesson_date,
    '2026-07-27',
    'reading a post after midnight must not shift the lesson to the next day',
  );
});

// ---------------------------------------------------------------------------
// Claim notices
// ---------------------------------------------------------------------------

test('a specific claim notice closes the matching lesson', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  const result = await ingestPost(
    db,
    { id: '1003', text: 'The 1-2 pm Needham lesson today has been claimed.', created_at: '2026-07-27T13:45:00Z' },
    deps,
  );

  assert.equal(result.status, 'claim_notice');
  assert.equal(result.affected, 1);
  assert.equal(lessons(db)[0].status, 'claimed_by_school');
});

test('a claim notice for a different time leaves our lesson alone', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  await ingestPost(
    db,
    { id: '1004', text: 'The 4-5 pm Needham lesson today has been claimed.', created_at: '2026-07-27T13:45:00Z' },
    deps,
  );

  assert.equal(lessons(db)[0].status, 'open');
});

test('a claim notice for a different town leaves our lesson alone', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(
    db,
    { id: '4001', text: 'Lesson open today 1-2 pm Natick. Email to claim.', created_at: '2026-07-27T12:00:00Z' },
    deps,
  );
  await ingestPost(
    db,
    { id: '4002', text: 'The 1-2 pm Needham lesson today has been claimed.', created_at: '2026-07-27T12:05:00Z' },
    deps,
  );

  assert.equal(lessons(db)[0].status, 'open', 'same time, different town — must survive');
});

test('a blanket claim closes every open lesson that day', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  await ingestPost(
    db,
    { id: '5001', text: 'Lesson open today 4-5 pm Dover. Email to claim.', created_at: '2026-07-27T12:00:00Z' },
    deps,
  );

  const result = await ingestPost(
    db,
    { id: '5002', text: 'All lessons have been claimed!', created_at: '2026-07-27T15:00:00Z' },
    deps,
  );

  assert.equal(result.affected, 2);
  assert.ok(lessons(db).every((l) => l.status === 'claimed_by_school'));
});

test('a blanket claim does not touch a different day', async () => {
  const db = freshDb();
  const { deps } = makeDeps();

  await ingestPost(
    db,
    { id: '6001', text: 'Lesson open tomorrow 1-2 pm Needham. Email to claim.', created_at: '2026-07-27T12:00:00Z' },
    deps,
  );
  await ingestPost(
    db,
    { id: '6002', text: 'All lessons have been claimed!', created_at: '2026-07-27T15:00:00Z' },
    deps,
  );

  assert.equal(lessons(db)[0].lesson_date, '2026-07-28');
  assert.equal(lessons(db)[0].status, 'open', "tomorrow's lesson survives today's blanket claim");
});

test('a claim notice never overwrites a lesson we already emailed for', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);
  assert.equal(sentEmails.length, 1);

  await ingestPost(
    db,
    { id: '7001', text: 'All lessons have been claimed!', created_at: '2026-07-27T15:00:00Z' },
    deps,
  );

  assert.equal(
    lessons(db)[0].status,
    'email_sent',
    'the dashboard must keep showing that we got our email in',
  );
});

// ---------------------------------------------------------------------------
// Claim sweep + race safety
// ---------------------------------------------------------------------------

test('a matching lesson gets exactly one email and one notification', async () => {
  const db = freshDb();
  const { deps, sentEmails, notifications } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  const tally = await runClaimSweep(db, deps);

  assert.deepEqual(tally, { sent: 1, skipped: 0, failed: 0, emails: 1 });
  assert.equal(sentEmails.length, 1);
  assert.equal(notifications.length, 1);

  const row = lessons(db)[0];
  assert.equal(row.status, 'email_sent');
  assert.ok(row.email_sent_at, 'email_sent_at is written only after SMTP confirms');
});

test('RACE SAFETY: repeated sweeps never send a second email', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);
  await runClaimSweep(db, deps);
  await runClaimSweep(db, deps);

  assert.equal(sentEmails.length, 1, 'three sweeps, one email');
});

test('RACE SAFETY: the atomic flip stops a concurrent sweep mid-flight', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();
  await ingestPost(db, OPENING_POST, deps);

  // Simulate a second worker claiming the row while the first is inside its
  // (awaited) email send. The flip to 'sending' has already happened, so the
  // interloper's own UPDATE matches zero rows and it must not send.
  let interfered = false;
  const racingDeps = {
    ...deps,
    sendClaimEmail: async (lesson) => {
      if (!interfered) {
        interfered = true;
        const stolen = db
          .prepare("UPDATE lessons SET status = 'sending' WHERE id = ? AND status IN ('open','skipped_no_match')")
          .run(lesson.id);
        assert.equal(stolen.changes, 0, 'the row was already locked to sending');
      }
      return deps.sendClaimEmail(lesson);
    },
  };

  await runClaimSweep(db, racingDeps);
  assert.equal(sentEmails.length, 1);
});

test('RACE SAFETY: a lesson mid-send is not picked up by a fresh sweep', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();
  await ingestPost(db, OPENING_POST, deps);

  db.prepare("UPDATE lessons SET status = 'sending' WHERE id = 1").run();
  const tally = await runClaimSweep(db, deps);

  assert.equal(sentEmails.length, 0);
  assert.equal(tally.sent, 0, "'sending' is outside the sweep's candidate set entirely");
});

test('a failed email reverts the lesson to open so the next cycle retries (§6)', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  await ingestPost(db, OPENING_POST, deps);

  let attempts = 0;
  const flaky = {
    ...deps,
    sendClaimEmail: async (lesson) => {
      attempts += 1;
      if (attempts === 1) throw new Error('SMTP connection reset');
      return { messageId: 'msg-retry', accepted: ['info@example.com'] };
    },
  };

  const first = await runClaimSweep(db, flaky);
  assert.equal(first.failed, 1);
  assert.equal(lessons(db)[0].status, 'open', 'must not be left stuck in sending');
  assert.ok(recentErrors(db).some((e) => /SMTP connection reset/.test(e.message)));

  const second = await runClaimSweep(db, flaky);
  assert.equal(second.sent, 1, 'the retry succeeds');
  assert.equal(lessons(db)[0].status, 'email_sent');
  assert.equal(attempts, 2);
});

test('a failed notification does not undo the email', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();
  await ingestPost(db, OPENING_POST, deps);

  const brokenNtfy = { ...deps, notify: async () => ({ ok: false, error: 'ntfy unreachable' }) };
  const tally = await runClaimSweep(db, brokenNtfy);

  assert.equal(tally.sent, 1);
  assert.equal(sentEmails.length, 1);
  assert.equal(lessons(db)[0].status, 'email_sent', '§7: notify failure must not change status');
  assert.ok(recentErrors(db).some((e) => /ntfy unreachable/.test(e.message)));
});

test('a notification that throws also does not undo the email', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  await ingestPost(db, OPENING_POST, deps);

  const throwingNtfy = {
    ...deps,
    notify: async () => {
      throw new Error('ntfy exploded');
    },
  };
  const tally = await runClaimSweep(db, throwingNtfy);

  assert.equal(tally.sent, 1);
  assert.equal(lessons(db)[0].status, 'email_sent');
});

// ---------------------------------------------------------------------------
// Skips recorded by the sweep
// ---------------------------------------------------------------------------

test('the bot being off records a skip and sends nothing', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();
  updateSettings(db, { scriptEnabled: false });

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);

  assert.equal(sentEmails.length, 0);
  const row = lessons(db)[0];
  assert.equal(row.status, 'skipped_no_match');
  assert.equal(row.skip_reason, 'script_off');
});

test('a wrong-area lesson is recorded with the specific reason', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  updateSettings(db, { areas: ['Dover'] });

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);

  assert.equal(lessons(db)[0].skip_reason, 'wrong_area');
});

test('a wrong-time lesson is recorded with the specific reason', async () => {
  const db = freshDb();
  const { deps } = makeDeps();
  updateSettings(db, { timeRangeStart: '17:00', timeRangeEnd: '21:00' });

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);

  assert.equal(lessons(db)[0].skip_reason, 'wrong_time');
});

test('fixing your settings rescues a lesson that was skipped a moment ago', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();
  updateSettings(db, { areas: ['Dover'] });

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);
  assert.equal(sentEmails.length, 0);
  assert.equal(lessons(db)[0].status, 'skipped_no_match');

  // You notice, tick Needham, and the very next sweep claims it.
  updateSettings(db, { areas: ['Needham'] });
  await runClaimSweep(db, deps);

  assert.equal(sentEmails.length, 1);
  assert.equal(lessons(db)[0].status, 'email_sent');
});

test('a school-claimed lesson is NOT rescued by changing settings', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();
  updateSettings(db, { areas: ['Dover'] });

  await ingestPost(db, OPENING_POST, deps);
  await runClaimSweep(db, deps);
  await ingestPost(
    db,
    { id: '8001', text: 'All lessons have been claimed!', created_at: '2026-07-27T15:00:00Z' },
    deps,
  );

  updateSettings(db, { areas: ['Needham'] });
  await runClaimSweep(db, deps);

  assert.equal(sentEmails.length, 0, 'a gone lesson stays gone');
  assert.equal(lessons(db)[0].status, 'claimed_by_school');
});

test('yesterday’s lessons drop out of the sweep', async () => {
  const db = freshDb();
  const { deps, sentEmails } = makeDeps();

  upsertLesson(
    db,
    { date: '2026-07-01', start_time: '13:00', end_time: '14:00', areas: ['Needham'] },
    'old-post',
  );

  const tally = await runClaimSweep(db, deps);
  assert.equal(tally.sent, 0);
  assert.equal(sentEmails.length, 0);
  assert.equal(lessons(db)[0].status, 'open', 'left untouched rather than churned every 10s');
});

test('applyClaimNotice with no date at all is a no-op', () => {
  const db = freshDb();
  const changed = applyClaimNotice(db, { is_blanket_claim: true, date: null, areas: [] }, null);
  assert.equal(changed, 0);
});
