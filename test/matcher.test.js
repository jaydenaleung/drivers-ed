import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLesson, effectiveWindow } from '../src/matcher.js';
import { SKIP_REASONS } from '../src/db.js';

const SETTINGS = {
  scriptEnabled: true,
  areas: ['Needham', 'Wellesley'],
  timeRangeStart: '09:00',
  timeRangeEnd: '21:00',
  dateRangeStart: '2026-07-01',
  dateRangeEnd: '2026-08-31',
  overrunBufferMinutes: 30,
};

const LESSON = {
  id: 1,
  lesson_date: '2026-07-27',
  start_time: '13:00',
  end_time: '14:00',
  areas: ['Needham', 'Wellesley'],
  status: 'open',
  email_sent_at: null,
};

const settings = (patch) => ({ ...SETTINGS, ...patch });
const lesson = (patch) => ({ ...LESSON, ...patch });

test('a fully matching lesson is claimed', () => {
  const v = evaluateLesson(lesson(), settings());
  assert.equal(v.matches, true);
  assert.equal(v.skipReason, null);
});

// --- every skip branch -----------------------------------------------------

test('SKIP: script off', () => {
  const v = evaluateLesson(lesson(), settings({ scriptEnabled: false }));
  assert.equal(v.matches, false);
  assert.equal(v.skipReason, SKIP_REASONS.SCRIPT_OFF);
});

test('SKIP: wrong area', () => {
  const v = evaluateLesson(lesson({ areas: ['Natick'] }), settings());
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_AREA);
});

test('SKIP: lesson with no areas at all', () => {
  const v = evaluateLesson(lesson({ areas: [] }), settings());
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_AREA);
});

test('SKIP: wrong date — before the range', () => {
  const v = evaluateLesson(lesson({ lesson_date: '2026-06-30' }), settings());
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_DATE);
});

test('SKIP: wrong date — after the range', () => {
  const v = evaluateLesson(lesson({ lesson_date: '2026-09-01' }), settings());
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_DATE);
});

test('SKIP: wrong time', () => {
  const v = evaluateLesson(lesson(), settings({ timeRangeStart: '15:00', timeRangeEnd: '20:00' }));
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_TIME);
});

test('SKIP: already claimed by the school', () => {
  const v = evaluateLesson(lesson({ status: 'claimed_by_school' }), settings());
  assert.equal(v.skipReason, SKIP_REASONS.ALREADY_CLAIMED);
});

test('SKIP: already emailed', () => {
  const v = evaluateLesson(
    lesson({ status: 'email_sent', email_sent_at: '2026-07-27 13:00:01' }),
    settings(),
  );
  assert.equal(v.skipReason, SKIP_REASONS.ALREADY_EMAILED);
});

test('SKIP: mid-send is treated as already emailed, never re-sent', () => {
  const v = evaluateLesson(lesson({ status: 'sending' }), settings());
  assert.equal(v.matches, false);
  assert.equal(v.skipReason, SKIP_REASONS.ALREADY_EMAILED);
});

test('state checks win over criteria checks', () => {
  // Wrong area AND already claimed — the claim is the more useful explanation.
  const v = evaluateLesson(lesson({ areas: ['Natick'], status: 'claimed_by_school' }), settings());
  assert.equal(v.skipReason, SKIP_REASONS.ALREADY_CLAIMED);
});

// --- Jayden's time rule: window + 30min overrun must fit ENTIRELY inside ----

test("TIME RULE: the scenario from Jayden's answer — 1-2pm vs a 12:00-13:30 range", () => {
  // Effective window is 13:00-14:30, which does not fit inside 12:00-13:30.
  const v = evaluateLesson(lesson(), settings({ timeRangeStart: '12:00', timeRangeEnd: '13:30' }));
  assert.equal(v.matches, false);
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_TIME);
});

test('TIME RULE: a range that exactly fits the buffered window matches', () => {
  const v = evaluateLesson(lesson(), settings({ timeRangeStart: '13:00', timeRangeEnd: '14:30' }));
  assert.equal(v.matches, true, '13:00-14:30 exactly contains the 1-2pm lesson plus 30 min');
});

test('TIME RULE: one minute short of the buffer is a miss', () => {
  const v = evaluateLesson(lesson(), settings({ timeRangeStart: '13:00', timeRangeEnd: '14:29' }));
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_TIME);
});

test('TIME RULE: the lesson start must also be inside the range', () => {
  const v = evaluateLesson(lesson(), settings({ timeRangeStart: '13:01', timeRangeEnd: '18:00' }));
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_TIME);
});

test('TIME RULE: buffer is configurable', () => {
  const noBuffer = settings({
    timeRangeStart: '13:00',
    timeRangeEnd: '14:00',
    overrunBufferMinutes: 0,
  });
  assert.equal(evaluateLesson(lesson(), noBuffer).matches, true);

  const bigBuffer = { ...noBuffer, overrunBufferMinutes: 60 };
  assert.equal(evaluateLesson(lesson(), bigBuffer).matches, false);
});

test('TIME RULE: a lesson with no end time is assumed to run one hour', () => {
  const open = lesson({ end_time: null });
  // 13:00 + 60min + 30min buffer = 14:30
  assert.equal(effectiveWindow(open, 30).endLabel, '14:30');

  assert.equal(
    evaluateLesson(open, settings({ timeRangeStart: '13:00', timeRangeEnd: '14:30' })).matches,
    true,
  );
  assert.equal(
    evaluateLesson(open, settings({ timeRangeStart: '13:00', timeRangeEnd: '14:00' })).matches,
    false,
  );
});

test('TIME RULE: a late lesson whose buffer runs past midnight cannot match', () => {
  const late = lesson({ start_time: '23:00', end_time: '23:59' });
  const v = evaluateLesson(late, settings({ timeRangeStart: '00:00', timeRangeEnd: '23:59' }));
  assert.equal(v.matches, false, '23:59 + 30min = 24:29, outside any same-day range');
});

test('effectiveWindow rejects unusable times rather than guessing', () => {
  assert.equal(effectiveWindow(lesson({ start_time: null }), 30), null);
  assert.equal(
    effectiveWindow(lesson({ start_time: '14:00', end_time: '13:00' }), 30),
    null,
    'end before start is nonsense, not a 23-hour lesson',
  );
});

// --- area rule: ANY selected area matches ----------------------------------

test('AREA RULE: a multi-town lesson matches on any one selected town', () => {
  const v = evaluateLesson(
    lesson({ areas: ['Needham', 'Wellesley'] }),
    settings({ areas: ['Needham'] }),
  );
  assert.equal(v.matches, true);
});

test('AREA RULE: no overlap at all is a miss', () => {
  const v = evaluateLesson(
    lesson({ areas: ['Dover', 'Natick'] }),
    settings({ areas: ['Needham', 'Wellesley'] }),
  );
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_AREA);
});

test('AREA RULE: no areas selected means nothing can match', () => {
  const v = evaluateLesson(lesson(), settings({ areas: [] }));
  assert.equal(v.skipReason, SKIP_REASONS.WRONG_AREA);
});

// --- date range: unset bounds are unbounded ---------------------------------

test('DATE RULE: unset bounds accept any date', () => {
  const open = settings({ dateRangeStart: null, dateRangeEnd: null });
  assert.equal(evaluateLesson(lesson({ lesson_date: '2030-01-01' }), open).matches, true);
  assert.equal(evaluateLesson(lesson({ lesson_date: '2020-01-01' }), open).matches, true);
});

test('DATE RULE: a one-sided bound only constrains that side', () => {
  const fromOnly = settings({ dateRangeStart: '2026-07-27', dateRangeEnd: null });
  assert.equal(evaluateLesson(lesson({ lesson_date: '2026-07-27' }), fromOnly).matches, true);
  assert.equal(evaluateLesson(lesson({ lesson_date: '2026-07-26' }), fromOnly).matches, false);
});

test('DATE RULE: range bounds are inclusive on both ends', () => {
  const s = settings({ dateRangeStart: '2026-07-27', dateRangeEnd: '2026-07-27' });
  assert.equal(evaluateLesson(lesson({ lesson_date: '2026-07-27' }), s).matches, true);
});
