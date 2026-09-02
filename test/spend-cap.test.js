import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, getState, STATE_KEYS } from '../src/db.js';
import { readsToday, recordReads, fetchNewPosts, SpendCapError } from '../src/x/client.js';
import { config } from '../src/config.js';

/**
 * X bills per post RETURNED, not per request. Idle polls cost nothing, so the
 * risk is never the poll frequency — it is a fault that makes every poll return
 * a full batch. At a 10s interval that is 8,640 polls a day, so the cap is the
 * difference between pennies and a genuinely bad surprise.
 */

const DAY_ONE = new Date('2026-09-02T10:00:00Z');
const SAME_DAY_LATER = new Date('2026-09-02T23:59:00Z');
const NEXT_DAY = new Date('2026-09-03T00:01:00Z');

function fakeFetch(postCount) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        data: Array.from({ length: postCount }, (_, i) => ({
          id: String(2000 + i),
          text: `post ${i}`,
          created_at: '2026-09-02T10:00:00Z',
        })),
        meta: { newest_id: String(2000 + postCount - 1), result_count: postCount },
      }),
  });
}

test('reads are counted per UTC day and reset at midnight', () => {
  const db = openDatabase(':memory:');

  assert.equal(readsToday(db, DAY_ONE), 0);

  recordReads(db, 5, DAY_ONE);
  assert.equal(readsToday(db, DAY_ONE), 5);

  recordReads(db, 3, SAME_DAY_LATER);
  assert.equal(readsToday(db, SAME_DAY_LATER), 8, 'same UTC day accumulates');

  assert.equal(readsToday(db, NEXT_DAY), 0, 'a new UTC day starts from zero');
});

test('a normal poll records exactly the posts returned', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(STATE_KEYS.SINCE_ID, '1999');

  await fetchNewPosts(db, { fetchImpl: fakeFetch(4), now: DAY_ONE });

  assert.equal(readsToday(db, DAY_ONE), 4, 'billed for posts returned, not requests made');
});

test('a poll returning nothing is free and does not move the counter', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(STATE_KEYS.SINCE_ID, '1999');

  const emptyFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ meta: { result_count: 0 } }),
  });

  await fetchNewPosts(db, { fetchImpl: emptyFetch, now: DAY_ONE });
  assert.equal(readsToday(db, DAY_ONE), 0, 'idle polls must stay free');
});

test('SPEND CAP: polling stops once the daily cap is reached', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(STATE_KEYS.SINCE_ID, '1999');

  recordReads(db, config.maxPostsPerDay, DAY_ONE);

  let called = false;
  const spyFetch = async () => {
    called = true;
    throw new Error('should never be reached');
  };

  await assert.rejects(
    () => fetchNewPosts(db, { fetchImpl: spyFetch, now: DAY_ONE }),
    (err) => {
      assert.ok(err instanceof SpendCapError);
      assert.match(err.message, /Daily X read cap reached/);
      return true;
    },
  );

  assert.equal(called, false, 'the request must not even be made once capped');
});

test('SPEND CAP: a runaway cursor is stopped instead of billing all day', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(STATE_KEYS.SINCE_ID, '1999');

  // Simulate the worst case: every poll returns a full batch because since_id
  // never advances. Unbounded, that is thousands of dollars a day.
  const alwaysFull = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        data: Array.from({ length: 100 }, (_, i) => ({ id: '1999', text: 'x' })),
        meta: {},
      }),
  });

  let polls = 0;
  let stopped = false;
  for (let i = 0; i < 200; i += 1) {
    try {
      await fetchNewPosts(db, { fetchImpl: alwaysFull, now: DAY_ONE });
      polls += 1;
    } catch (err) {
      if (err instanceof SpendCapError) {
        stopped = true;
        break;
      }
      throw err;
    }
  }

  assert.equal(stopped, true, 'the cap must engage');
  const spent = readsToday(db, DAY_ONE) * 0.005;
  assert.ok(spent <= (config.maxPostsPerDay + 100) * 0.005, `bounded spend, got $${spent}`);
  assert.ok(polls < 200, 'it stopped well before the loop would have');
});

test('SPEND CAP: the cap lifts on the next UTC day', async () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(STATE_KEYS.SINCE_ID, '1999');
  recordReads(db, config.maxPostsPerDay, DAY_ONE);

  await assert.rejects(() => fetchNewPosts(db, { fetchImpl: fakeFetch(1), now: DAY_ONE }));

  // Same database, next UTC day — polling resumes with no intervention.
  const result = await fetchNewPosts(db, { fetchImpl: fakeFetch(2), now: NEXT_DAY });
  assert.equal(result.posts.length, 2);
  assert.equal(readsToday(db, NEXT_DAY), 2);
});
