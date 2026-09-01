import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimEmail, formatMonthDay, formatClockTime, formatAreas } from '../src/email.js';

const lesson = (patch) => ({
  lesson_date: '2026-09-01',
  start_time: '14:00',
  end_time: '15:00',
  areas: ['Needham'],
  ...patch,
});

test('formatting helpers', () => {
  assert.equal(formatMonthDay('2026-09-01'), 'September 1');
  assert.equal(formatMonthDay('2026-12-25'), 'December 25');
  assert.equal(formatClockTime('14:00'), '2:00 PM');
  assert.equal(formatClockTime('09:30'), '9:30 AM');
  assert.equal(formatClockTime('12:00'), '12:00 PM');
  assert.equal(formatClockTime('00:00'), '12:00 AM');
  assert.equal(formatAreas(['Needham']), 'Needham');
  assert.equal(formatAreas(['Needham', 'Wellesley']), 'Needham/Wellesley');
  assert.equal(formatAreas(['Needham', 'Dover', 'Natick']), 'Needham/Dover/Natick');
});

test('a single lesson still produces the exact §6 template', () => {
  const { subject, text } = buildClaimEmail(lesson(), { fromName: 'Jayden Leung' });

  assert.equal(subject, 'Claiming lesson – September 1, 2:00 PM-3:00 PM Needham');
  assert.equal(
    text,
    [
      'Hi,',
      '',
      "I'd like to claim the open lesson on September 1 from 2:00 PM-3:00 PM in Needham.",
      '',
      'Thanks,',
      'Jayden Leung',
      '',
    ].join('\n'),
  );
});

test('a single lesson accepts either a bare object or a one-item array', () => {
  const a = buildClaimEmail(lesson());
  const b = buildClaimEmail([lesson()]);
  assert.deepEqual(a, b);
});

test('several lessons on one day are bulleted under a shared date', () => {
  const { subject, text } = buildClaimEmail(
    [
      lesson({ start_time: '14:00', end_time: '15:00', areas: ['Needham', 'Dedham'] }),
      lesson({ start_time: '15:00', end_time: '16:00', areas: ['Wellesley'] }),
      lesson({ start_time: '17:00', end_time: null, areas: ['Needham', 'Dover'] }),
    ],
    { fromName: 'Jayden Leung' },
  );

  assert.match(subject, /^Claiming/);
  assert.equal(
    text,
    [
      'Hi,',
      '',
      "I'd like to claim the following open lessons on September 1:",
      '',
      '- 2:00 PM-3:00 PM in Needham/Dedham',
      '- 3:00 PM-4:00 PM in Wellesley',
      '- 5:00 PM in Needham/Dover',
      '',
      '',
      'Thanks,',
      'Jayden Leung',
      '',
    ].join('\n'),
  );
});

test('lessons are listed chronologically regardless of input order', () => {
  const { text } = buildClaimEmail([
    lesson({ start_time: '17:00', end_time: '18:00' }),
    lesson({ start_time: '09:00', end_time: '10:00' }),
    lesson({ start_time: '14:00', end_time: '15:00' }),
  ]);

  const order = ['9:00 AM', '2:00 PM', '5:00 PM'].map((t) => text.indexOf(t));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'must read in time order');
});

test('lessons spanning several days carry their own dates', () => {
  const { text } = buildClaimEmail([
    lesson({ lesson_date: '2026-09-01', start_time: '14:00', end_time: '15:00' }),
    lesson({ lesson_date: '2026-09-02', start_time: '09:00', end_time: '10:00' }),
  ]);

  assert.match(text, /^- September 1 2:00 PM-3:00 PM in Needham$/m);
  assert.match(text, /^- September 2 9:00 AM-10:00 AM in Needham$/m);
  assert.ok(!/lessons on September 1:/.test(text), 'no single shared date when they differ');
});

test('a long list collapses the subject but keeps the full body', () => {
  const many = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'].map((t) =>
    lesson({ start_time: t, end_time: null, areas: ['Needham', 'Westwood', 'Dover'] }),
  );
  const { subject, text } = buildClaimEmail(many);

  assert.equal(subject, 'Claiming 7 lessons – September 1');
  assert.ok(subject.length < 90, 'subject must not be truncated by mail clients');
  for (const t of ['9:00 AM', '10:00 AM', '11:00 AM', '1:00 PM', '4:00 PM']) {
    assert.ok(text.includes(t), `body must still list ${t}`);
  }
});

test('a lesson with no end time is written as a single time', () => {
  const { subject } = buildClaimEmail(lesson({ end_time: null }));
  assert.equal(subject, 'Claiming lesson – September 1, 2:00 PM Needham');
});

test('building an email with no lessons is a programming error, not a blank send', () => {
  assert.throws(() => buildClaimEmail([]), /no lessons/);
});
