import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DASHBOARD_PASSWORD = 'pw';
process.env.SESSION_SECRET = 'a'.repeat(64);
process.env.X_BEARER_TOKEN = 'test-token';
process.env.X_ACCOUNT_USER_ID = '1234567890';
process.env.DRY_RUN = 'true';
process.env.X_REQUEST_TIMEOUT_SECONDS = '1';
// The shipped default: no self-imposed request ceiling.
process.env.MAX_REQUESTS_PER_DAY = '0';

const { openDatabase, getState, setState, STATE_KEYS } = await import('../src/db.js');
const {
  fetchNewPosts,
  UsageCapError,
  RateLimitedError,
  RequestTimeoutError,
  CreditsDepletedError,
  describeLimits,
  observedRateCaps,
} = await import('../src/x/client.js');

/** Builds a fake fetch returning the given status/body/headers. */
function fakeFetch({ status = 200, body = {}, headers = {} } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: (n) => (n.toLowerCase() in headers ? String(headers[n.toLowerCase()]) : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function primedDb() {
  const db = openDatabase(':memory:');
  // A stored cursor means this is not a first run, so posts are processed.
  setState(db, STATE_KEYS.SINCE_ID, '1000');
  return db;
}

// ---------------------------------------------------------------------------
// The 2 Sep failure: "usage cap exceeded" is not an ordinary rate limit
// ---------------------------------------------------------------------------

test('a usage cap 429 is its own error, not a plain rate limit', async () => {
  const db = primedDb();
  await assert.rejects(
    fetchNewPosts(db, {
      fetchImpl: fakeFetch({
        status: 429,
        body: { title: 'UsageCapExceeded', detail: 'usage cap exceeded', period: 'Monthly', scope: 'Account' },
      }),
    }),
    (err) => {
      assert.ok(err instanceof UsageCapError, `expected UsageCapError, got ${err.name}`);
      assert.ok(!(err instanceof RateLimitedError), 'must not be treated as a transient rate limit');
      assert.equal(err.period, 'Monthly');
      assert.equal(err.scope, 'Account');
      assert.match(err.message, /BLIND/);
      return true;
    },
  );
  db.close();
});

test('an ordinary 429 is still a plain rate limit', async () => {
  const db = primedDb();
  await assert.rejects(
    fetchNewPosts(db, {
      fetchImpl: fakeFetch({ status: 429, body: { detail: 'Too Many Requests' } }),
    }),
    (err) => {
      assert.ok(err instanceof RateLimitedError);
      assert.ok(!(err instanceof UsageCapError));
      return true;
    },
  );
  db.close();
});

test('the numbers X sent are carried into the error message', async () => {
  // The 2 Sep journal recorded only "usage cap exceeded" and threw away every
  // figure, which is why the cap could not be identified afterwards.
  const db = primedDb();
  await assert.rejects(
    fetchNewPosts(db, {
      fetchImpl: fakeFetch({
        status: 429,
        body: { detail: 'usage cap exceeded' },
        headers: {
          'x-rate-limit-limit': '900',
          'x-rate-limit-remaining': '0',
          'x-rate-limit-reset': '1788400000',
          'x-app-limit-24hour-limit': '10000',
          'x-app-limit-24hour-remaining': '0',
        },
      }),
    }),
    (err) => {
      assert.match(err.message, /15min limit 900/);
      assert.match(err.message, /remaining 0/);
      assert.match(err.message, /24h limit 10000/);
      assert.match(err.message, /resets 2026-/, 'the reset unix time is rendered as a clock time');
      return true;
    },
  );
  db.close();
});

test('an error response with no cap headers says so rather than implying none exist', () => {
  assert.match(describeLimits({ get: () => null }), /sent no rate-limit headers/);
});

test('caps are recorded even when the response is a 429', async () => {
  const db = primedDb();
  await assert.rejects(
    fetchNewPosts(db, {
      fetchImpl: fakeFetch({
        status: 429,
        body: { detail: 'usage cap exceeded' },
        headers: { 'x-app-limit-24hour-limit': '2000', 'x-app-limit-24hour-remaining': '0' },
      }),
    }),
  );

  const caps = observedRateCaps(db);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].limit, 2000);
  assert.equal(caps[0].source, 'observed');
  db.close();
});

// ---------------------------------------------------------------------------
// The hang: a request with no deadline stalls the loop silently
// ---------------------------------------------------------------------------

test('a request that never responds fails instead of hanging forever', async () => {
  const db = primedDb();

  // Never resolves on its own — only the abort signal can end this.
  const hangingFetch = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'TimeoutError';
        reject(err);
      });
    });

  // AbortSignal.timeout() uses an UNREF'd timer, so with nothing else pending
  // this test's event loop would drain before it fires. In production the open
  // socket of a hung request keeps the loop alive; here we stand in for it.
  const keepAlive = setInterval(() => {}, 20);

  try {
    const started = Date.now();
    await assert.rejects(fetchNewPosts(db, { fetchImpl: hangingFetch }), (err) => {
      assert.ok(err instanceof RequestTimeoutError, `expected RequestTimeoutError, got ${err.name}`);
      assert.match(err.message, /did not respond within 1s/);
      return true;
    });

    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 900, `aborted after ${elapsed}ms — the deadline should be honoured, not instant`);
    assert.ok(elapsed < 5000, 'the timeout must actually fire, not wait indefinitely');
  } finally {
    clearInterval(keepAlive);
    db.close();
  }
});

test('every request carries an abort signal', async () => {
  const db = primedDb();
  let sawSignal = false;

  await fetchNewPosts(db, {
    fetchImpl: async (url, options) => {
      sawSignal = options?.signal instanceof AbortSignal;
      return (await fakeFetch({ body: { data: [], meta: {} } })());
    },
  });

  assert.equal(sawSignal, true, 'a request with no deadline is what caused the 14h silent outage');
  db.close();
});

// ---------------------------------------------------------------------------
// The Cloudflare page: an HTML error body must not become the error message
// ---------------------------------------------------------------------------

test('a Cloudflare HTML error page is summarised, not dumped', async () => {
  const db = primedDb();
  const html = `<!DOCTYPE html><html><head><title>api.x.com | 524: A timeout occurred</title></head>
    <body><h1>Error 524</h1>${'<div>padding</div>'.repeat(500)}
    Performance &amp; security by Cloudflare</body></html>`;

  await assert.rejects(
    fetchNewPosts(db, { fetchImpl: fakeFetch({ status: 524, body: html }) }),
    (err) => {
      assert.ok(err.message.length < 400, `error message was ${err.message.length} chars`);
      assert.ok(!err.message.includes('<div>'), 'raw markup must not reach the journal');
      assert.match(err.message, /Cloudflare error page \(524\)/);
      return true;
    },
  );
  db.close();
});

// ---------------------------------------------------------------------------
// The cursor: why the backlog arrived all at once after the restart
// ---------------------------------------------------------------------------

test('a failed poll leaves the cursor untouched so nothing is skipped', async () => {
  const db = primedDb();
  const before = getState(db, STATE_KEYS.SINCE_ID);

  await assert.rejects(
    fetchNewPosts(db, { fetchImpl: fakeFetch({ status: 429, body: { detail: 'usage cap exceeded' } }) }),
  );

  assert.equal(getState(db, STATE_KEYS.SINCE_ID), before, 'the cursor must not advance on failure');
  db.close();
});

test('the whole backlog arrives in one batch once polling recovers', async () => {
  // This is exactly what happened at 01:15:07 on 3 Sep: six posts published
  // during the outage were all ingested within one second of the restart.
  const db = primedDb();

  await assert.rejects(
    fetchNewPosts(db, { fetchImpl: fakeFetch({ status: 429, body: { detail: 'usage cap exceeded' } }) }),
  );

  const backlog = {
    data: [
      { id: '1006', text: 'sixth', created_at: '2026-09-02T17:59:15Z' },
      { id: '1005', text: 'fifth', created_at: '2026-09-02T17:55:08Z' },
      { id: '1001', text: 'first', created_at: '2026-09-02T15:55:59Z' },
    ],
    meta: { newest_id: '1006' },
  };

  const result = await fetchNewPosts(db, { fetchImpl: fakeFetch({ body: backlog }) });

  assert.equal(result.posts.length, 3, 'everything published during the outage comes back at once');
  assert.equal(result.primed, false);
  assert.deepEqual(
    result.posts.map((p) => p.id),
    ['1001', '1005', '1006'],
    'oldest first, so a lesson posted and then claimed is seen in that order',
  );
  assert.equal(getState(db, STATE_KEYS.SINCE_ID), '1006', 'the cursor advances only on success');
  db.close();
});

test('with no budget set, polling is never stopped by us', async () => {
  // Jayden's call: poll until X refuses, rather than guessing at a limit
  // nobody can look up. A guessed ceiling mostly prevents us learning the real
  // one.
  const db = primedDb();
  const { requestsToday } = await import('../src/x/client.js');

  for (let i = 0; i < 25; i += 1) {
    await fetchNewPosts(db, { fetchImpl: fakeFetch({ body: { data: [], meta: {} } }) });
  }

  assert.equal(requestsToday(db), 25, 'requests are still counted — that is the evidence');
  // The 26th must go through too; nothing here may refuse it.
  const result = await fetchNewPosts(db, { fetchImpl: fakeFetch({ body: { data: [], meta: {} } }) });
  assert.deepEqual(result.posts, []);
  db.close();
});

test('the request count is available to attach to a failure', async () => {
  // The one fact missing on 2 Sep: how many requests it took to get refused.
  const db = primedDb();
  const { requestsToday } = await import('../src/x/client.js');

  await fetchNewPosts(db, { fetchImpl: fakeFetch({ body: { data: [], meta: {} } }) });
  await assert.rejects(
    fetchNewPosts(db, { fetchImpl: fakeFetch({ status: 429, body: { detail: 'usage cap exceeded' } }) }),
  );

  assert.equal(requestsToday(db), 2, 'the refused request is counted, because X counted it');
  db.close();
});

test('credit exhaustion is still distinguished from a usage cap', async () => {
  const db = primedDb();
  await assert.rejects(
    fetchNewPosts(db, { fetchImpl: fakeFetch({ status: 402, body: { detail: 'CreditsDepleted' } }) }),
    (err) => {
      assert.ok(err instanceof CreditsDepletedError);
      return true;
    },
  );
  db.close();
});
