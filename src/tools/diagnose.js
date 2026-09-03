/**
 * Reconstructs what the bot was doing, from the database rather than the log.
 *
 *   npm run diagnose
 *
 * `journalctl -n 40` only ever shows the tail, and journald may not even retain
 * logs across a reboot. The database does, and it holds two independent records
 * of every outage:
 *
 *   1. `errors` — every failed poll, with its message and time.
 *   2. `posts_seen` — when X published a post (posted_at) versus when we first
 *      read it (fetched_at). A large gap between the two is proof the bot was
 *      not looking, and it survives restarts, log rotation and journald limits.
 *
 * Reads only. No API call, no cost.
 */
import { config } from '../config.js';
import { openDatabase, getState, STATE_KEYS } from '../db.js';
import { observedRateCaps, requestsToday, readsToday } from '../x/client.js';

const db = openDatabase();
const arg = process.argv.slice(2).find((a) => /^--days=/.test(a));
const DAYS = arg ? Number(arg.split('=')[1]) : 14;

console.log(`\ndrivers-ed diagnosis — last ${DAYS} days\n${'='.repeat(60)}`);

// ---------------------------------------------------------------------------
// 1. Ingestion lag: the hard evidence of a blind period
// ---------------------------------------------------------------------------

console.log('\n1. INGESTION LAG — how long after publication we first saw each post');
console.log('   A lag of minutes is normal. Hours means the bot was not polling.\n');

const posts = db
  .prepare(
    `SELECT post_id, posted_at, fetched_at
       FROM posts_seen
      WHERE posted_at IS NOT NULL
        AND fetched_at > datetime('now', ?)
      ORDER BY posted_at`,
  )
  .all(`-${DAYS} days`);

if (posts.length === 0) {
  console.log('   No posts recorded in this period.');
} else {
  const lagged = [];
  for (const p of posts) {
    // SQLite stores fetched_at as "YYYY-MM-DD HH:MM:SS" in UTC.
    const published = new Date(p.posted_at);
    const seen = new Date(`${p.fetched_at.replace(' ', 'T')}Z`);
    const lagMin = (seen - published) / 60000;
    if (Number.isFinite(lagMin)) lagged.push({ ...p, published, seen, lagMin });
  }

  const bad = lagged.filter((l) => l.lagMin > 30).sort((a, b) => b.lagMin - a.lagMin);
  const median = lagged.length
    ? [...lagged].sort((a, b) => a.lagMin - b.lagMin)[Math.floor(lagged.length / 2)].lagMin
    : 0;

  console.log(`   ${lagged.length} posts, median lag ${median.toFixed(1)} min`);

  if (bad.length === 0) {
    console.log('   No post was seen more than 30 minutes late. No blind period detected.');
  } else {
    console.log(`\n   ${bad.length} post(s) seen more than 30 minutes late:\n`);
    console.log(`   ${'published (UTC)'.padEnd(21)}${'first seen (UTC)'.padEnd(21)}late by`);
    for (const l of bad.slice(0, 25)) {
      console.log(
        `   ${l.published.toISOString().slice(0, 19).replace('T', ' ').padEnd(21)}` +
          `${l.seen.toISOString().slice(0, 19).replace('T', ' ').padEnd(21)}` +
          `${(l.lagMin / 60).toFixed(1)}h`,
      );
    }
    // Posts read in the same second, all long overdue, is the signature of a
    // backlog arriving at once when polling resumed.
    const byFetch = new Map();
    for (const l of bad) {
      const key = l.seen.toISOString().slice(0, 16);
      byFetch.set(key, (byFetch.get(key) ?? 0) + 1);
    }
    const batches = [...byFetch.entries()].filter(([, n]) => n > 1);
    if (batches.length) {
      console.log('\n   Backlogs (several overdue posts read at once — polling had resumed):');
      for (const [when, n] of batches) console.log(`     ${when}Z  ${n} posts`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Poll failures
// ---------------------------------------------------------------------------

console.log(`\n2. POLL FAILURES — grouped by message\n`);

const grouped = db
  .prepare(
    `SELECT message, COUNT(*) n, MIN(occurred_at) first_at, MAX(occurred_at) last_at
       FROM errors
      WHERE stage = 'poll' AND occurred_at > datetime('now', ?)
      GROUP BY message
      ORDER BY MAX(occurred_at) DESC`,
  )
  .all(`-${DAYS} days`);

if (grouped.length === 0) {
  console.log('   No poll failures recorded.');
} else {
  for (const g of grouped) {
    const oneLine = g.message.replace(/\s+/g, ' ').slice(0, 150);
    console.log(`   x${String(g.n).padStart(5)}  ${g.first_at} -> ${g.last_at}`);
    console.log(`          ${oneLine}\n`);
  }
  console.log(
    '   A failure that appears ONCE and is then followed by silence did not\n' +
      '   retry — the loop stopped rather than backing off. A failure repeating\n' +
      '   every 60-600s is the backoff working as intended.',
  );
}

// ---------------------------------------------------------------------------
// 3. Silence: periods with neither a success nor a logged failure
// ---------------------------------------------------------------------------

console.log(`\n3. GAPS IN THE RECORD\n`);

const marks = db
  .prepare(
    `SELECT occurred_at AS at FROM errors WHERE occurred_at > datetime('now', ?)
      UNION ALL
     SELECT fetched_at AS at FROM posts_seen WHERE fetched_at > datetime('now', ?)
      ORDER BY at`,
  )
  .all(`-${DAYS} days`, `-${DAYS} days`);

if (marks.length < 2) {
  console.log('   Not enough recorded activity to measure gaps.');
} else {
  const gaps = [];
  for (let i = 1; i < marks.length; i += 1) {
    const a = new Date(`${marks[i - 1].at.replace(' ', 'T')}Z`);
    const b = new Date(`${marks[i].at.replace(' ', 'T')}Z`);
    const hours = (b - a) / 3600000;
    if (hours > 2) gaps.push({ from: marks[i - 1].at, to: marks[i].at, hours });
  }

  if (gaps.length === 0) {
    console.log('   No gap longer than 2 hours between recorded events.');
  } else {
    console.log('   Periods with nothing recorded at all. Some are just quiet');
    console.log('   nights or closed active-hours windows; a long one that ENDS');
    console.log('   with a backlog above is an outage.\n');
    for (const g of gaps.sort((x, y) => y.hours - x.hours).slice(0, 15)) {
      console.log(`     ${g.from} -> ${g.to}   ${g.hours.toFixed(1)}h`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Current state
// ---------------------------------------------------------------------------

console.log(`\n4. NOW\n`);
console.log('   Last successful poll :', getState(db, STATE_KEYS.LAST_POLL_OK_AT) ?? 'never');
console.log('   Last poll error      :', (getState(db, STATE_KEYS.LAST_POLL_ERROR) ?? 'none').slice(0, 200));
console.log('   Poll interval        :', `${config.pollIntervalSeconds}s`);
console.log(
  '   Requests today       :',
  `${requestsToday(db).toLocaleString('en-US')}` +
    (config.maxRequestsPerDay > 0
      ? ` / ${config.maxRequestsPerDay.toLocaleString('en-US')} budget`
      : ' (no budget — polling until X refuses)'),
);
console.log('   Billable reads today :', readsToday(db).toLocaleString('en-US'));

const caps = observedRateCaps(db);
console.log(
  '   Caps X has reported  :',
  caps.length ? caps.map((c) => `${c.label} ${c.limit}/${c.windowSeconds}s`).join('; ') : 'none seen',
);

console.log(
  '\nIf a cutoff happens again, the request count at that moment, the full 429\n' +
    'body and every rate-limit header X sent are all recorded now. That is what\n' +
    'was missing on 2 Sep.\n',
);

db.close();
