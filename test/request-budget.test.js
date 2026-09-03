import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_PASSWORD = 'pw';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.X_BEARER_TOKEN = 'test-token';
process.env.X_ACCOUNT_USER_ID = '1234567890';
process.env.DRY_RUN = 'true';
// Small enough to reach inside a test.
process.env.MAX_REQUESTS_PER_DAY = '3';

const { openDatabase, setState, STATE_KEYS } = await import('../src/db.js');
const { fetchNewPosts, RequestBudgetError, requestsToday } = await import('../src/x/client.js');
const { pollingCapacity, budgetCap, capacityNote } = await import('../src/capacity.js');

const emptyResponse = async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  text: async () => JSON.stringify({ data: [], meta: {} }),
});

function primedDb() {
  const db = openDatabase(':memory:');
  setState(db, STATE_KEYS.SINCE_ID, '1000');
  return db;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('every request is counted, including ones that return nothing', async () => {
  // This is the whole point: on 2 Sep almost every request returned nothing, so
  // the billing counter stayed near zero while the request counter hit ~18,000.
  const db = primedDb();
  assert.equal(requestsToday(db), 0);

  await fetchNewPosts(db, { fetchImpl: emptyResponse });
  await fetchNewPosts(db, { fetchImpl: emptyResponse });

  assert.equal(requestsToday(db), 2);
  db.close();
});

test('a request that fails still counts against the budget', async () => {
  const db = primedDb();
  const boom = async () => {
    throw new Error('connection reset');
  };

  await assert.rejects(fetchNewPosts(db, { fetchImpl: boom }));
  assert.equal(requestsToday(db), 1, 'X counted it even though we got nothing back');
  db.close();
});

test('the counter rolls over at UTC midnight', async () => {
  const db = primedDb();
  const day1 = new Date('2026-09-02T23:59:00Z');
  const day2 = new Date('2026-09-03T00:01:00Z');

  await fetchNewPosts(db, { fetchImpl: emptyResponse, now: day1 });
  assert.equal(requestsToday(db, day1), 1);
  assert.equal(requestsToday(db, day2), 0, 'a new UTC day starts from zero');
  db.close();
});

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

test('polling stops at the budget instead of letting X cut us off', async () => {
  const db = primedDb();

  for (let i = 0; i < 3; i += 1) {
    await fetchNewPosts(db, { fetchImpl: emptyResponse });
  }

  await assert.rejects(fetchNewPosts(db, { fetchImpl: emptyResponse }), (err) => {
    assert.ok(err instanceof RequestBudgetError, `expected RequestBudgetError, got ${err.name}`);
    assert.match(err.message, /3\/3 requests today/);
    assert.match(err.message, /usage cap exceeded/, 'the message explains where the number came from');
    return true;
  });

  db.close();
});

test('the blocked request is not itself counted', async () => {
  const db = primedDb();
  for (let i = 0; i < 3; i += 1) await fetchNewPosts(db, { fetchImpl: emptyResponse });

  await assert.rejects(fetchNewPosts(db, { fetchImpl: emptyResponse }));
  assert.equal(requestsToday(db), 3, 'refusing to call X must not inflate the tally');
  db.close();
});

test('no HTTP call is made once the budget is spent', async () => {
  const db = primedDb();
  for (let i = 0; i < 3; i += 1) await fetchNewPosts(db, { fetchImpl: emptyResponse });

  let called = false;
  await assert.rejects(
    fetchNewPosts(db, {
      fetchImpl: async (...args) => {
        called = true;
        return emptyResponse(...args);
      },
    }),
  );
  assert.equal(called, false, 'the guard must run before the request, not after');
  db.close();
});

test('the budget clears on the next UTC day', async () => {
  const db = primedDb();
  const day1 = new Date('2026-09-02T12:00:00Z');
  for (let i = 0; i < 3; i += 1) await fetchNewPosts(db, { fetchImpl: emptyResponse, now: day1 });

  await assert.rejects(fetchNewPosts(db, { fetchImpl: emptyResponse, now: day1 }));

  const day2 = new Date('2026-09-03T00:00:01Z');
  const result = await fetchNewPosts(db, { fetchImpl: emptyResponse, now: day2 });
  assert.deepEqual(result.posts, [], 'polling resumes without a restart');
  db.close();
});

// ---------------------------------------------------------------------------
// The budget as a capacity cap
// ---------------------------------------------------------------------------

test('the budget is modelled as a cap and can be the binding one', () => {
  // 10,000 requests/day at 3s covers 30,000 seconds = 8.33 hours.
  const capacity = pollingCapacity(3, [], 10000);
  assert.equal(capacity.unlimited, false);
  assert.equal(capacity.limitedBy.id, 'own_daily_budget');
  assert.equal(Math.round(capacity.hoursPerDay * 100) / 100, 8.33);
  assert.equal(capacity.requestsPerDay, 28800);
});

test('a slower interval makes the same budget stretch further', () => {
  assert.equal(pollingCapacity(9, [], 10000).unlimited, true, '9s x 10,000 covers the whole day');
  assert.equal(pollingCapacity(30, [], 10000).unlimited, true);
});

test('no budget configured means no budget cap', () => {
  assert.equal(budgetCap(0), null);
  assert.equal(budgetCap(null), null);
  assert.equal(
    pollingCapacity(3, []).caps.some((c) => c.id === 'own_daily_budget'),
    false,
  );
});

test('the 13-hour window at 3s is flagged against a 10,000 budget', () => {
  // The configuration that was actually running: 06:00-19:00 at 3 seconds.
  const note = capacityNote(
    { activeWindowEnabled: true, activeStart: '06:00', activeEnd: '19:00' },
    3,
    [],
    10000,
  );

  assert.equal(note.requestedHours, 13);
  assert.equal(note.requestsInWindow, 15600, 'a 13h window at 3s is still 15,600 requests a day');
  assert.equal(note.shortfall, true, 'this must raise the red warning');
  assert.equal(note.limitedBy.id, 'own_daily_budget');
});

test('the documented 15-minute figure is the corrected one', () => {
  // It previously said 10,000, which was wrong. X documents 3,500/15min per app
  // for GET /2/users/:id/tweets.
  const fifteen = pollingCapacity(3).caps.find((c) => c.id === 'requests_15min');
  assert.equal(fifteen.limit, 3500);
  assert.equal(fifteen.binds, false, '300 requests per 15 min is still comfortably under it');
});
