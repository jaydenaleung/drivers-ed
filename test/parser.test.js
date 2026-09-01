import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWithRegex } from '../src/parser/regex.js';
import { mergeParserResults } from '../src/parser/index.js';
import { normaliseHaikuOutput } from '../src/parser/haiku.js';
import {
  parseTimeRange,
  parseDateExpression,
  extractAreas,
  dedupeKey,
  todayInTz,
  addDays,
} from '../src/parser/normalize.js';

// A fixed "now" so "today"/"tomorrow" are deterministic.
// 2026-07-27 14:00 UTC == 2026-07-27 10:00 in America/New_York.
const NOW = new Date('2026-07-27T14:00:00Z');
const OPTS = { now: NOW, timezone: 'America/New_York' };

// ---------------------------------------------------------------------------
// The one real example post from INSTRUCTIONS.md §5.
// ---------------------------------------------------------------------------

const REAL_OPENING =
  'Lesson Open Today July 27th: 1-2 pm Needham/Wellesley Email info@needhamdrivingschool.com to claim this hour.';

test('REAL EXAMPLE — opening post from INSTRUCTIONS.md §5', () => {
  const r = parseWithRegex(REAL_OPENING, OPTS);

  assert.equal(r.is_lesson_opening, true);
  assert.equal(r.is_claim_notice, false, '"to claim this hour" is an invitation, not a claim');
  assert.equal(r.date, '2026-07-27');
  assert.equal(r.start_time, '13:00');
  assert.equal(r.end_time, '14:00');
  assert.deepEqual(r.areas, ['Needham', 'Wellesley']);
});

test('REAL EXAMPLE — blanket claim from INSTRUCTIONS.md §5', () => {
  const r = parseWithRegex('All lessons have been claimed!', OPTS);

  assert.equal(r.is_claim_notice, true);
  assert.equal(r.is_blanket_claim, true);
  assert.equal(r.is_lesson_opening, false);
  assert.equal(r.start_time, null);
});

// ---------------------------------------------------------------------------
// Variants I wrote myself. These are GUESSES at how the school might word
// things — they are not real posts. Replace with real ones when available.
// ---------------------------------------------------------------------------

test('VARIANT — no meridiem on the start time', () => {
  const r = parseWithRegex('Lesson open today: 10-12 pm in Dover', OPTS);
  // "10-12 pm" naively reads as 22:00-12:00; the start must be morning.
  assert.equal(r.start_time, '10:00');
  assert.equal(r.end_time, '12:00');
  assert.deepEqual(r.areas, ['Dover']);
});

test('VARIANT — half-hour start, single town', () => {
  const r = parseWithRegex('Open slot tomorrow 1:30-3pm Natick. Email to claim!', OPTS);
  assert.equal(r.is_lesson_opening, true);
  assert.equal(r.date, '2026-07-28');
  assert.equal(r.start_time, '13:30');
  assert.equal(r.end_time, '15:00');
  assert.deepEqual(r.areas, ['Natick']);
});

test('VARIANT — numeric date and "to" instead of a dash', () => {
  const r = parseWithRegex('Lesson available 8/3: 9 am to 11 am, Weston/Westwood', OPTS);
  assert.equal(r.date, '2026-08-03');
  assert.equal(r.start_time, '09:00');
  assert.equal(r.end_time, '11:00');
  assert.deepEqual(r.areas, ['Weston', 'Westwood']);
});

test('VARIANT — specific claim notice', () => {
  const r = parseWithRegex('The 1-2 pm Needham lesson today has been claimed. Thanks!', OPTS);
  assert.equal(r.is_claim_notice, true);
  assert.equal(r.is_blanket_claim, false);
  assert.equal(r.is_lesson_opening, false);
  assert.equal(r.start_time, '13:00');
  assert.deepEqual(r.areas, ['Needham']);
});

test('VARIANT — "no longer available" beats the word "available"', () => {
  const r = parseWithRegex('UPDATE: the 3-4pm Dedham slot is no longer available.', OPTS);
  assert.equal(r.is_claim_notice, true);
  assert.equal(r.is_lesson_opening, false);
});

test('VARIANT — "taken" reads as a claim', () => {
  const r = parseWithRegex("Today's 2-3 pm Wellesley hour has been taken.", OPTS);
  assert.equal(r.is_claim_notice, true);
  assert.equal(r.is_lesson_opening, false);
});

test('VARIANT — unrelated post is neither an opening nor a claim', () => {
  const r = parseWithRegex('Congratulations to all our students who passed this week!', OPTS);
  assert.equal(r.is_lesson_opening, false);
  assert.equal(r.is_claim_notice, false);
});

test('VARIANT — closed for a holiday is not an opening', () => {
  const r = parseWithRegex('We are closed Monday for the holiday. No lessons.', OPTS);
  assert.equal(r.is_lesson_opening, false);
});

// ---------------------------------------------------------------------------
// The "Needham" trap: the school's own name and email both contain a town.
// ---------------------------------------------------------------------------

test('school name in a signature does not become an area', () => {
  const r = parseWithRegex(
    'Open lesson today 1-2 pm in Natick. Email us to claim. — Needham Driving School',
    OPTS,
  );
  assert.deepEqual(r.areas, ['Natick'], 'the signature must not add Needham');
});

test('email domain does not become an area', () => {
  const r = parseWithRegex(
    'Lesson open today 1-2pm Dover. Contact info@needhamdrivingschool.com',
    OPTS,
  );
  assert.deepEqual(r.areas, ['Dover']);
});

test('a URL containing a town name does not become an area', () => {
  const r = parseWithRegex(
    'Lessons open today 1-2pm Dedham. Book at https://example.com/weston-branch',
    OPTS,
  );
  assert.deepEqual(r.areas, ['Dedham'], 'Weston appears only inside the scrubbed URL');
});

// ---------------------------------------------------------------------------
// Time parsing edge cases
// ---------------------------------------------------------------------------

test('parseTimeRange handles meridiem inference', () => {
  assert.deepEqual(parseTimeRange('1-2 pm'), { start: '13:00', end: '14:00' });
  assert.deepEqual(parseTimeRange('10-12 pm'), { start: '10:00', end: '12:00' });
  assert.deepEqual(parseTimeRange('11-1 pm'), { start: '11:00', end: '13:00' });
  assert.deepEqual(parseTimeRange('9 am - 10 am'), { start: '09:00', end: '10:00' });
  assert.deepEqual(parseTimeRange('1pm-2pm'), { start: '13:00', end: '14:00' });
  assert.deepEqual(parseTimeRange('1 p.m. to 3 p.m.'), { start: '13:00', end: '15:00' });
});

test('parseTimeRange uses driving-school hours when no meridiem is given', () => {
  // Bare "1-2" on a driving school post means the afternoon.
  assert.deepEqual(parseTimeRange('lesson 1-2 today'), { start: '13:00', end: '14:00' });
  assert.deepEqual(parseTimeRange('lesson 9-11 today'), { start: '09:00', end: '11:00' });
});

test('parseTimeRange rejects impossible ranges rather than guessing', () => {
  assert.deepEqual(parseTimeRange('no times here'), { start: null, end: null });
  assert.deepEqual(parseTimeRange('25-26'), { start: null, end: null });
});

test('parseTimeRange falls back to a lone start time', () => {
  assert.deepEqual(parseTimeRange('Lesson open at 3pm'), { start: '15:00', end: null });
});

// ---------------------------------------------------------------------------
// Date parsing edge cases
// ---------------------------------------------------------------------------

test('an explicit date beats a relative word in the same post', () => {
  // "Today July 27th" contains both; the explicit date is authoritative.
  assert.equal(parseDateExpression('Lesson Open Today July 27th', OPTS), '2026-07-27');
});

test('parseDateExpression handles the relative words', () => {
  assert.equal(parseDateExpression('open today', OPTS), '2026-07-27');
  assert.equal(parseDateExpression('open tomorrow', OPTS), '2026-07-28');
  assert.equal(parseDateExpression('open tonight', OPTS), '2026-07-27');
});

test('parseDateExpression handles ordinals, abbreviations, and slashes', () => {
  assert.equal(parseDateExpression('Aug 3rd', OPTS), '2026-08-03');
  assert.equal(parseDateExpression('August 3', OPTS), '2026-08-03');
  assert.equal(parseDateExpression('8/3/2026', OPTS), '2026-08-03');
  assert.equal(parseDateExpression('8/3/26', OPTS), '2026-08-03');
});

test('parseDateExpression rolls a long-past date into next year', () => {
  // On 2026-07-27, "January 5th" is ~6 months back — it means 2027.
  assert.equal(parseDateExpression('January 5th', OPTS), '2027-01-05');
});

test('parseDateExpression rejects impossible dates', () => {
  assert.equal(parseDateExpression('February 30th', OPTS), null);
  assert.equal(parseDateExpression('no date here', OPTS), null);
});

test('todayInTz respects the timezone, not the server clock', () => {
  // 03:00 UTC on the 28th is still the 27th in New York.
  const lateNight = new Date('2026-07-28T03:00:00Z');
  assert.equal(todayInTz('America/New_York', lateNight), '2026-07-27');
  assert.equal(todayInTz('UTC', lateNight), '2026-07-28');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-07-31', 1), '2026-08-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

// ---------------------------------------------------------------------------
// Areas and dedupe identity
// ---------------------------------------------------------------------------

test('extractAreas is case-insensitive and canonically ordered', () => {
  assert.deepEqual(extractAreas('needham and WESTON'), ['Needham', 'Weston']);
  // Canonical order, not post order — this is what makes dedupe_key stable.
  assert.deepEqual(extractAreas('Wellesley/Needham'), ['Needham', 'Wellesley']);
});

test('extractAreas requires whole words', () => {
  assert.deepEqual(extractAreas('Westwooding is not a town'), []);
  assert.deepEqual(extractAreas('Doverton'), []);
});

test('dedupeKey is order-independent — one lesson, one key', () => {
  const a = dedupeKey({ date: '2026-07-27', start_time: '13:00', areas: ['Needham', 'Wellesley'] });
  const b = dedupeKey({ date: '2026-07-27', start_time: '13:00', areas: ['Wellesley', 'Needham'] });
  assert.equal(a, b);
});

test('dedupeKey separates different times and dates', () => {
  const base = { date: '2026-07-27', start_time: '13:00', areas: ['Needham'] };
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, start_time: '14:00' }));
  assert.notEqual(dedupeKey(base), dedupeKey({ ...base, date: '2026-07-28' }));
});

// ---------------------------------------------------------------------------
// Haiku output handling (pure functions — no API call)
// ---------------------------------------------------------------------------

test('normaliseHaikuOutput discards values in the wrong format', () => {
  const out = normaliseHaikuOutput({
    is_lesson_opening: true,
    is_claim_notice: false,
    is_blanket_claim: false,
    date: 'July 27th', // not YYYY-MM-DD
    lessons: [
      { start_time: '1pm', end_time: '14:00', areas: ['Needham'] }, // bad time -> dropped
      { start_time: '13:00', end_time: 'later', areas: ['Needham', 'Atlantis'] },
    ],
    claim_start_time: null,
    claim_areas: [],
  });

  assert.equal(out.date, null, 'a date in the wrong format is discarded');
  assert.equal(out.lessons.length, 1, 'a lesson with an unusable start time is dropped');
  assert.equal(out.lessons[0].start_time, '13:00');
  assert.equal(out.lessons[0].end_time, null, 'an unusable end time becomes null');
  assert.deepEqual(out.lessons[0].areas, ['Needham'], 'unknown towns are dropped');
});

test('mergeParserResults backfills Haiku gaps from regex', () => {
  const haiku = {
    is_lesson_opening: true,
    is_claim_notice: false,
    is_blanket_claim: false,
    date: null,
    lessons: [],
    start_time: null,
    end_time: null,
    areas: [],
  };
  const regex = {
    is_lesson_opening: false,
    is_claim_notice: false,
    is_blanket_claim: false,
    date: '2026-07-27',
    lessons: [{ start_time: '13:00', end_time: '14:00', areas: ['Needham'] }],
    start_time: '13:00',
    end_time: '14:00',
    areas: ['Needham'],
  };

  const merged = mergeParserResults(haiku, regex);
  assert.equal(merged.is_lesson_opening, true, 'classification comes from Haiku');
  assert.equal(merged.date, '2026-07-27', 'values are backfilled from regex');
  assert.deepEqual(merged.areas, ['Needham']);
});

test('mergeParserResults keeps Haiku values when it has them', () => {
  const haiku = {
    is_lesson_opening: true,
    is_claim_notice: false,
    is_blanket_claim: false,
    date: '2026-07-27',
    lessons: [{ start_time: '13:00', end_time: '14:00', areas: ['Wellesley'] }],
    start_time: '13:00',
    end_time: '14:00',
    areas: ['Wellesley'],
  };
  const regex = { ...haiku, date: '2026-01-01', start_time: '09:00', areas: ['Needham'] };

  const merged = mergeParserResults(haiku, regex);
  assert.equal(merged.date, '2026-07-27');
  assert.equal(merged.start_time, '13:00');
  assert.deepEqual(merged.areas, ['Wellesley']);
});
