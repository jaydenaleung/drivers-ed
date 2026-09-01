import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWithRegex, parseOfferLine } from '../src/parser/regex.js';
import { openDatabase } from '../src/db.js';
import { updateSettings } from '../src/settings.js';
import { ingestPost, runClaimSweep, hydrate } from '../src/pipeline.js';
import { KNOWN_AREAS } from '../src/config.js';

/**
 * Regression tests built from ACTUAL posts pulled from @NeedhamDriving on
 * 2026-09-01. Everything here is real wording, not invented.
 *
 * The original parser scored 0 lessons against every one of these, because it
 * required the singular "Lesson" while the school always writes "Lessons", and
 * because it only ever extracted one lesson per post. These tests exist so
 * neither regression can return.
 */

const opts = (postedOnDate) => ({ postedOnDate, timezone: 'America/New_York' });

// --- the plural bug that made the bot blind ---------------------------------

test('REAL: plural "Lessons" is recognised as an opening', () => {
  const r = parseWithRegex('Lessons available on Saturday, 8/29!\n\n3 pm or 4 pm - Needham only', opts('2026-08-28'));
  assert.equal(r.is_lesson_opening, true, 'the school never writes the singular "Lesson"');
});

// --- multi-lesson extraction ------------------------------------------------

test('REAL: "3 pm or 4 pm - Needham only" is TWO lessons', () => {
  const r = parseWithRegex(
    'Lessons available on Saturday, 8/29!\n\n3 pm or 4 pm - Needham only\n\nEmail info@needhamdrivingschool.com to claim!',
    opts('2026-08-28'),
  );
  assert.equal(r.date, '2026-08-29');
  assert.equal(r.lessons.length, 2);
  assert.deepEqual(r.lessons.map((l) => l.start_time), ['15:00', '16:00']);
  assert.ok(r.lessons.every((l) => l.areas.length === 1 && l.areas[0] === 'Needham'));
});

test('REAL: a four-time list becomes four lessons', () => {
  const lessons = parseOfferLine('8 am, 9 am, 10 am or 11 am - Needham, Westwood or Dover');
  assert.deepEqual(lessons.map((l) => l.start_time), ['08:00', '09:00', '10:00', '11:00']);
  for (const l of lessons) {
    assert.deepEqual(l.areas, ['Needham', 'Dover', 'Westwood']);
    assert.equal(l.end_time, null, 'a listed start time implies a one-hour lesson');
  }
});

test('REAL: the full Sunday post yields eight lessons across three lines', () => {
  const text = [
    'Lessons available on Sunday, 8/30!',
    '',
    '8 am, 9 am, 10 am or 11 am - Needham, Westwood or Dover',
    '',
    '9 am, 1 pm or 2 pm - Needham, Westwood or Dedham',
    '',
    '9 am - Needham or Wellesley',
    '',
    'Email info@needhamdrivingschool.com to claim!',
  ].join('\n');

  const r = parseWithRegex(text, opts('2026-08-28'));
  assert.equal(r.date, '2026-08-30');
  assert.equal(r.lessons.length, 8);

  // 9am appears on all three lines but with DIFFERENT towns — three lessons,
  // not one merged one.
  const nineAm = r.lessons.filter((l) => l.start_time === '09:00');
  assert.equal(nineAm.length, 3);
  assert.deepEqual(nineAm.map((l) => l.areas.join('/')).sort(), [
    'Needham/Dedham/Westwood',
    'Needham/Dover/Westwood',
    'Needham/Wellesley',
  ].sort());
});

test('REAL: ranged form keeps each line’s towns separate', () => {
  const text = [
    'Lessons Open Today:',
    '',
    '5-6 pm Needham/Westwood/Dover',
    '5-6 pm Wellesley/Natick',
    '6-7 pm Needham/Wellesley',
    '',
    'Email info@needhamdrivingschool.com to claim these hours',
  ].join('\n');

  const r = parseWithRegex(text, opts('2026-08-31'));
  assert.equal(r.lessons.length, 3);

  const [a, b, c] = r.lessons;
  assert.deepEqual([a.start_time, a.end_time], ['17:00', '18:00']);
  assert.deepEqual(a.areas, ['Needham', 'Dover', 'Westwood']);

  // Two lessons share 5-6pm but are genuinely different slots in different
  // towns. Merging them would invent a Wellesley lesson at Needham's slot.
  assert.deepEqual([b.start_time, b.end_time], ['17:00', '18:00']);
  assert.deepEqual(b.areas, ['Natick', 'Wellesley']);

  assert.deepEqual([c.start_time, c.end_time], ['18:00', '19:00']);
});

test('REAL: the busiest observed post yields nine lessons', () => {
  const text = [
    'Lessons available today, 9/1!',
    '',
    '2 pm or 4 pm - Needham, Dedham or Westwood',
    '',
    '3 pm - Wellesley only',
    '',
    '4 pm, 5 pm or 9 pm - Needham, Dover or Westwood',
    '',
    '5 pm or 6 pm - Needham or Wellesley',
    '',
    '6 pm - Weston or Wellesley',
    '',
    'Email info@needhamdrivingschool.com to claim!',
  ].join('\n');

  const r = parseWithRegex(text, opts('2026-09-01'));
  assert.equal(r.date, '2026-09-01');
  assert.equal(r.lessons.length, 9);
  assert.deepEqual(
    r.lessons.find((l) => l.start_time === '15:00').areas,
    ['Wellesley'],
    '"3 pm - Wellesley only" must not inherit towns from neighbouring lines',
  );
});

// --- claim notices ----------------------------------------------------------

test('REAL: weekday-only claim notice resolves to the right day', () => {
  // Posted Friday 2026-08-28; "Saturday" means the 29th, NOT the post date.
  const r = parseWithRegex('Saturday lessons have been claimed!', opts('2026-08-28'));
  assert.equal(r.is_claim_notice, true);
  assert.equal(r.date, '2026-08-29', 'falling back to the post date would clear the wrong day');
});

test('REAL: "Sunday lessons have been claimed!" resolves to the Sunday', () => {
  const r = parseWithRegex('Sunday lessons have been claimed!', opts('2026-08-28'));
  assert.equal(r.date, '2026-08-30');
});

test('REAL: shouted blanket claim is recognised', () => {
  const r = parseWithRegex('ALL HOURS TODAY HAVE BEEN CLAIMED!', opts('2026-08-31'));
  assert.equal(r.is_claim_notice, true);
  assert.equal(r.is_blanket_claim, true);
  assert.equal(r.date, '2026-08-31');
});

test('REAL: bare "1 pm has been claimed" is a specific claim', () => {
  const r = parseWithRegex('1 pm has been claimed', opts('2026-08-28'));
  assert.equal(r.is_claim_notice, true);
  assert.equal(r.is_blanket_claim, false);
  assert.equal(r.start_time, '13:00');
});

test('REAL: "All lessons have been claimed" (no exclamation) is blanket', () => {
  const r = parseWithRegex('All lessons have been claimed', opts('2026-08-28'));
  assert.equal(r.is_blanket_claim, true);
});

// --- end to end through the pipeline ---------------------------------------

function freshDb() {
  const db = openDatabase(':memory:');
  updateSettings(db, {
    scriptEnabled: true,
    areas: KNOWN_AREAS,
    timeRangeStart: '06:00',
    timeRangeEnd: '23:00',
    dateRangeStart: null,
    dateRangeEnd: null,
    overrunBufferMinutes: 30,
  });
  return db;
}

function stubDeps(sent) {
  return {
    parsePost: async (text, o) => ({ parsed: parseWithRegex(text, o), parser: 'regex', haikuError: null }),
    sendClaimEmail: async (lesson) => {
      sent.push(lesson);
      return { messageId: `m${sent.length}`, accepted: ['x@example.com'] };
    },
    notify: async () => ({ ok: true }),
    now: () => new Date('2026-09-01T16:00:00Z'),
    timezone: 'America/New_York',
  };
}

const BUSY_POST = {
  id: 'real-9',
  created_at: '2026-09-01T16:47:00Z',
  text: [
    'Lessons available today, 9/1!',
    '',
    '2 pm or 4 pm - Needham, Dedham or Westwood',
    '',
    '3 pm - Wellesley only',
    '',
    '4 pm, 5 pm or 9 pm - Needham, Dover or Westwood',
    '',
    'Email info@needhamdrivingschool.com to claim!',
  ].join('\n'),
};

test('REAL: one post creates one lessons row per advertised hour', async () => {
  const db = freshDb();
  const sent = [];
  const result = await ingestPost(db, BUSY_POST, stubDeps(sent));

  assert.equal(result.status, 'lesson_recorded');
  assert.equal(result.count, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, 6);
});

test('REAL: a busy post claims every matching hour in ONE email', async () => {
  const db = freshDb();
  const sent = [];
  const deps = stubDeps(sent);

  await ingestPost(db, BUSY_POST, deps);
  const tally = await runClaimSweep(db, deps);

  assert.equal(sent.length, 1, 'six matching hours must not become six separate emails');
  assert.equal(sent[0].length, 6, 'all six go into that one email');
  assert.equal(tally.sent, 6, 'six lessons claimed');
  assert.equal(tally.emails, 1, 'in a single message');

  const rows = db.prepare('SELECT * FROM lessons').all().map(hydrate);
  assert.equal(rows.filter((l) => l.status === 'email_sent').length, 6);
});

test('REAL: matches from DIFFERENT posts share the same single email', async () => {
  const db = freshDb();
  const sent = [];
  const deps = stubDeps(sent);

  await ingestPost(db, BUSY_POST, deps);
  await ingestPost(
    db,
    {
      id: 'real-other',
      created_at: '2026-09-01T17:00:00Z',
      text: 'Lessons Open Today:\n\n7-8 pm Natick/Weston',
    },
    deps,
  );

  const tally = await runClaimSweep(db, deps);
  assert.equal(sent.length, 1, 'one sweep sends at most one email');
  assert.equal(tally.sent, 7, 'six from the busy post plus the 7pm Natick/Weston hour');
});

test('REAL: a blanket claim closes every hour from that day', async () => {
  const db = freshDb();
  const sent = [];
  const deps = stubDeps(sent);

  await ingestPost(db, BUSY_POST, deps);
  const claim = await ingestPost(
    db,
    { id: 'real-10', created_at: '2026-09-01T16:49:00Z', text: 'All lessons have been claimed!' },
    deps,
  );

  assert.equal(claim.status, 'claim_notice');
  assert.equal(claim.affected, 6, 'all six hours from the earlier post are closed');

  await runClaimSweep(db, deps);
  assert.equal(sent.length, 0, 'nothing is claimable after the blanket notice');
});
