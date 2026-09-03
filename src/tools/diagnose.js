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
import {
  LATE_MINUTES,
  buildActivity,
  classifyAftermath,
  typicalLagSeconds,
  indexingDelaySeconds,
} from '../diagnostics.js';

const db = openDatabase();
const arg = process.argv.slice(2).find((a) => /^--days=/.test(a));
const DAYS = arg ? Number(arg.split('=')[1]) : 14;

/** SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC; X sends ISO-8601 with a Z. */
function toDate(value) {
  if (!value) return null;
  const text = /[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hoursBetween = (a, b) => (b - a) / 3600000;

console.log(`\ndrivers-ed diagnosis — last ${DAYS} days\n${'='.repeat(60)}`);

// ---------------------------------------------------------------------------
// Shared evidence: when each post was published vs when we read it
// ---------------------------------------------------------------------------

const posts = db
  .prepare(
    `SELECT post_id, posted_at, fetched_at
       FROM posts_seen
      WHERE posted_at IS NOT NULL
        AND fetched_at > datetime('now', ?)
      ORDER BY posted_at`,
  )
  .all(`-${DAYS} days`);

const lagged = [];
for (const p of posts) {
  const published = toDate(p.posted_at);
  const seen = toDate(p.fetched_at);
  if (!published || !seen) continue;
  lagged.push({ ...p, published, seen, lagMin: (seen - published) / 60000 });
}

const latePosts = lagged.filter((l) => l.lagMin > LATE_MINUTES);

const pollErrors = db
  .prepare(
    `SELECT occurred_at, message
       FROM errors
      WHERE stage = 'poll' AND occurred_at > datetime('now', ?)
      ORDER BY occurred_at`,
  )
  .all(`-${DAYS} days`)
  .map((e) => ({ ...e, at: toDate(e.occurred_at) }))
  .filter((e) => e.at);

// Everything the bot is known to have done, in order. Used to measure silence.
const activity = buildActivity(lagged, pollErrors);

const whatFollowed = (at) => classifyAftermath(at, activity, latePosts);

// ---------------------------------------------------------------------------
// 1. Ingestion lag
// ---------------------------------------------------------------------------

console.log('\n1. INGESTION LAG — how long after publication we first saw each post');
console.log('   A lag of seconds is normal. Hours means the bot was not polling.\n');

if (lagged.length === 0) {
  console.log('   No posts recorded in this period.');
} else {
  const promptCount = lagged.length - latePosts.length;
  console.log(`   ${lagged.length} posts, ${promptCount} read promptly, ${latePosts.length} late`);

  const typical = typicalLagSeconds(lagged);
  if (typical !== null) {
    console.log(`   Typical lag when working: ${typical.toFixed(0)}s`);
    const xDelay = indexingDelaySeconds(typical, config.pollIntervalSeconds);
    if (promptCount >= 5 && xDelay > 1) {
      console.log(
        `   Roughly ${xDelay.toFixed(0)}s of that is X's own indexing delay rather than the\n` +
          `   poll interval, so halving the interval would save at most ${(config.pollIntervalSeconds / 2).toFixed(0)}s.`,
      );
    }
  }

  if (latePosts.length === 0) {
    console.log(`   No post was seen more than ${LATE_MINUTES} minutes late. No blind period detected.`);
  } else {
    console.log(`\n   ${latePosts.length} post(s) seen more than ${LATE_MINUTES} minutes late:\n`);
    console.log(`   ${'published (UTC)'.padEnd(21)}${'first seen (UTC)'.padEnd(21)}late by`);
    for (const l of [...latePosts].sort((a, b) => b.lagMin - a.lagMin).slice(0, 25)) {
      console.log(`   ${fmt(l.published).padEnd(21)}${fmt(l.seen).padEnd(21)}${(l.lagMin / 60).toFixed(1)}h`);
    }

    const byFetch = new Map();
    for (const l of latePosts) {
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
// 2. Poll failures, each judged by what actually followed it
// ---------------------------------------------------------------------------

console.log(`\n2. POLL FAILURES — and whether the bot came back\n`);

if (pollErrors.length === 0) {
  console.log('   No poll failures recorded.');
} else {
  // Group identical messages, but judge the LAST occurrence of each: that is
  // the one whose aftermath tells us whether the bot recovered.
  const groups = new Map();
  for (const e of pollErrors) {
    const key = e.message;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const ordered = [...groups.entries()].sort(
    (a, b) => b[1][b[1].length - 1].at - a[1][a[1].length - 1].at,
  );

  for (const [message, occurrences] of ordered) {
    const last = occurrences[occurrences.length - 1];
    const first = occurrences[0];
    const { verdict, detail } = whatFollowed(last.at);

    const label =
      verdict === 'STALLED'
        ? 'STALLED — the loop stopped'
        : verdict === 'recovered'
          ? 'recovered'
          : 'no evidence either way';

    console.log(
      `   x${String(occurrences.length).padStart(5)}  ${first.occurred_at}` +
        (occurrences.length > 1 ? ` -> ${last.occurred_at}` : ''),
    );
    console.log(`          ${message.replace(/\s+/g, ' ').slice(0, 150)}`);
    console.log(`          after the last one: ${label} (${detail})`);
    if (occurrences.length > 1) {
      const spacing = (hoursBetween(first.at, last.at) * 3600) / (occurrences.length - 1);
      console.log(`          retried ${occurrences.length} times, ~${spacing.toFixed(0)}s apart — backoff was running`);
    }
    console.log('');
  }

  console.log(
    '   How to read this: a lone failure followed by silence usually means the\n' +
      '   RETRY WORKED — a successful poll that finds nothing logs nothing, so an\n' +
      '   idle stretch looks identical to a dead process. Only the combination of\n' +
      '   a long silence AND posts published during it that arrived late proves\n' +
      '   the loop stopped. That conjunction is what "STALLED" above means.',
  );
}

// ---------------------------------------------------------------------------
// 3. Silence, classified the same way
// ---------------------------------------------------------------------------

console.log(`\n3. GAPS IN THE RECORD\n`);

if (activity.length < 2) {
  console.log('   Not enough recorded activity to measure gaps.');
} else {
  const gaps = [];
  for (let i = 1; i < activity.length; i += 1) {
    const hours = hoursBetween(activity[i - 1].at, activity[i].at);
    if (hours > 2) gaps.push({ from: activity[i - 1].at, to: activity[i].at, hours });
  }

  if (gaps.length === 0) {
    console.log('   No gap longer than 2 hours between recorded events.');
  } else {
    for (const g of gaps.sort((x, y) => y.hours - x.hours).slice(0, 15)) {
      // Late posts read at the END of the gap are what turn silence into proof.
      const overdue = latePosts.filter((l) => l.published >= g.from && l.published <= g.to);
      const tag = overdue.length
        ? `OUTAGE — ${overdue.length} post(s) published during it, all read at the end`
        : 'probably idle — nothing was published, so nothing was missed';
      console.log(`     ${fmt(g.from)} -> ${fmt(g.to)}   ${g.hours.toFixed(1)}h`);
      console.log(`       ${tag}\n`);
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
