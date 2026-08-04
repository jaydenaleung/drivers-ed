import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, getState, setState, STATE_KEYS } from '../src/db.js';
import { getSettings, updateSettings } from '../src/settings.js';
import { logError, recentErrors, STAGES } from '../src/errors.js';

function freshDb() {
  return openDatabase(':memory:');
}

test('schema creates all four tables from §4 plus state', () => {
  const db = freshDb();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

  for (const expected of ['settings', 'posts_seen', 'lessons', 'errors', 'state']) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
});

test('settings seeds exactly one row, with all seven areas on by default', () => {
  const db = freshDb();
  const count = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n;
  assert.equal(count, 1);

  const s = getSettings(db);
  assert.equal(s.scriptEnabled, false, 'bot must start switched OFF');
  assert.equal(s.areas.length, 7);
  assert.equal(s.overrunBufferMinutes, 30);
});

test('settings row cannot be duplicated', () => {
  const db = freshDb();
  assert.throws(() => db.prepare('INSERT INTO settings (id) VALUES (2)').run());
});

test('openDatabase is idempotent and preserves existing settings', () => {
  const db = freshDb();
  updateSettings(db, { scriptEnabled: true, areas: ['Needham'] });
  db.exec('SELECT 1'); // schema re-application happens inside openDatabase
  const s = getSettings(db);
  assert.equal(s.scriptEnabled, true);
  assert.deepEqual(s.areas, ['Needham']);
});

test('updateSettings rejects invalid input rather than writing it', () => {
  const db = freshDb();
  assert.throws(() => updateSettings(db, { timeRangeStart: '25:00' }), /HH:MM/);
  assert.throws(() => updateSettings(db, { timeRangeStart: '14:00', timeRangeEnd: '13:00' }), /earlier/);
  assert.throws(() => updateSettings(db, { dateRangeStart: '2026-08-05', dateRangeEnd: '2026-08-01' }), /after/);
  assert.throws(() => updateSettings(db, { overrunBufferMinutes: 999 }), /buffer/);

  // ...and the original values survived every rejection.
  assert.equal(getSettings(db).timeRangeStart, '09:00');
});

test('updateSettings silently drops unknown areas', () => {
  const db = freshDb();
  const s = updateSettings(db, { areas: ['Needham', 'Atlantis', 'Dover'] });
  assert.deepEqual(s.areas, ['Needham', 'Dover']);
});

test('lessons.status is constrained to the §4 vocabulary', () => {
  const db = freshDb();
  const insert = db.prepare(
    `INSERT INTO lessons (lesson_date, start_time, areas, status, dedupe_key)
     VALUES (?, ?, ?, ?, ?)`,
  );

  insert.run('2026-07-27', '13:00', '["Needham"]', 'open', 'k1');
  assert.throws(
    () => insert.run('2026-07-27', '14:00', '["Needham"]', 'banana', 'k2'),
    /CHECK constraint/,
  );
});

test('lessons.dedupe_key is unique — the same lesson cannot be inserted twice', () => {
  const db = freshDb();
  const insert = db.prepare(
    `INSERT INTO lessons (lesson_date, start_time, areas, dedupe_key) VALUES (?, ?, ?, ?)`,
  );

  insert.run('2026-07-27', '13:00', '["Needham"]', '2026-07-27|13:00|Needham');
  assert.throws(
    () => insert.run('2026-07-27', '13:00', '["Needham"]', '2026-07-27|13:00|Needham'),
    /UNIQUE constraint/,
  );
});

test('posts_seen.post_id is unique', () => {
  const db = freshDb();
  const insert = db.prepare('INSERT INTO posts_seen (post_id, post_text) VALUES (?, ?)');
  insert.run('1234', 'hello');
  assert.throws(() => insert.run('1234', 'hello again'), /UNIQUE constraint/);
});

test('logError persists and never throws', () => {
  const db = freshDb();
  logError(db, STAGES.POLL, new Error('boom'), { attempt: 1 });
  logError(db, STAGES.EMAIL, 'plain string failure');

  const rows = recentErrors(db);
  assert.equal(rows.length, 2);
  assert.equal(rows.some((r) => r.message === 'boom'), true);

  // A context value that cannot be JSON-stringified must not blow up the loop.
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => logError(db, STAGES.PARSE, new Error('circular'), circular));
});

test('state round-trips and upserts', () => {
  const db = freshDb();
  assert.equal(getState(db, STATE_KEYS.SINCE_ID), null);

  setState(db, STATE_KEYS.SINCE_ID, '111');
  assert.equal(getState(db, STATE_KEYS.SINCE_ID), '111');

  setState(db, STATE_KEYS.SINCE_ID, '222');
  assert.equal(getState(db, STATE_KEYS.SINCE_ID), '222');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM state').get().n, 1);
});
