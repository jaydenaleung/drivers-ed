/**
 * Prints what X has actually told us about its rate caps.
 *
 *   npm run caps
 *
 * Reads the database only — no API call, so it costs nothing and works even
 * while the bot is capped. This exists because of the 2 Sep 2026 outage: the
 * journal recorded the string "usage cap exceeded" and not one number, so there
 * was no way afterwards to say what the cap actually was. Every response now
 * stores its cap headers; this is how you read them back.
 */
import { config } from '../config.js';
import { openDatabase, getState, STATE_KEYS } from '../db.js';
import { observedRateCaps, requestsToday, readsToday } from '../x/client.js';
import { pollingCapacity, DOCUMENTED_CAPS } from '../capacity.js';
import { getSettings } from '../settings.js';

const db = openDatabase();

console.log('\nWhat X has reported about its rate caps\n');

const caps = observedRateCaps(db);
const seenAt = getState(db, STATE_KEYS.RATE_CAPS_AT);

if (caps.length === 0) {
  console.log('  No cap headers recorded yet.');
  console.log('');
  console.log('  This means one of:');
  console.log('    - the bot has not completed a poll since the header capture was added, or');
  console.log('    - X does not send rate-limit headers on this endpoint.');
  console.log('');
  console.log('  Until one is seen, the dashboard uses the documented figures:');
  for (const c of DOCUMENTED_CAPS) {
    console.log(`    ${c.label}: ${c.limit.toLocaleString('en-US')} per ${c.windowSeconds}s (from the docs)`);
  }
} else {
  console.log(`  Last seen: ${seenAt ?? 'unknown'}\n`);
  for (const c of caps) {
    const window = c.windowSeconds >= 3600 ? `${c.windowSeconds / 3600}h` : `${c.windowSeconds / 60}min`;
    const remaining = c.remaining === null || c.remaining === undefined ? '?' : c.remaining;
    console.log(
      `    ${c.label.padEnd(28)} ${String(c.limit).padStart(7)} per ${window.padEnd(6)} ` +
        `remaining ${remaining}`,
    );
  }
}

// --- what that means at the current poll interval ---------------------------

const capacity = pollingCapacity(config.pollIntervalSeconds, caps, config.maxRequestsPerDay);
console.log(`\n  At POLL_INTERVAL_SECONDS=${config.pollIntervalSeconds}:`);

for (const c of capacity.caps) {
  const verdict = c.binds
    ? `BINDS — allows ${(Math.round(c.hoursPerDay * 10) / 10).toFixed(1)}h/day of polling`
    : 'does not bind';
  console.log(
    `    ${c.label.padEnd(28)} we would use ${String(Math.round(c.requestsPerWindow)).padStart(7)} ` +
      `of ${String(c.limit).padStart(7)} — ${verdict}  [${c.source}]`,
  );
}

console.log(
  capacity.unlimited
    ? `\n  => No cap binds. The bot can poll continuously, 24h/day.`
    : `\n  => About ${(Math.round(capacity.hoursPerDay * 10) / 10).toFixed(1)}h/day of polling, limited by ${capacity.limitedBy.label}.`,
);

const settings = getSettings(db);
if (settings.activeWindowEnabled) {
  console.log(`     Your active window asks for ${settings.activeStart}–${settings.activeEnd}.`);
}

// --- the last thing that went wrong -----------------------------------------

console.log('\n  Today (UTC day, resets at midnight UTC):');
console.log(`    requests made        ${requestsToday(db).toLocaleString('en-US')} / ${config.maxRequestsPerDay.toLocaleString('en-US')} budget`);
console.log(`    billable post reads  ${readsToday(db).toLocaleString('en-US')} / ${config.maxPostsPerDay.toLocaleString('en-US')} cap  ($${(readsToday(db) * 0.005).toFixed(2)})`);

const lastError = getState(db, STATE_KEYS.LAST_POLL_ERROR);
const lastOk = getState(db, STATE_KEYS.LAST_POLL_OK_AT);

console.log('\n  Last successful poll :', lastOk ?? 'never');
if (lastOk) {
  const hours = (Date.now() - new Date(lastOk).getTime()) / 3600000;
  if (hours > 1) console.log(`                         (${hours.toFixed(1)} hours ago — the bot may be blind)`);
}
console.log('  Last poll error      :', lastError ?? 'none');

// A usage cap is the failure that looks momentary and is not.
if (lastError && /usage cap/i.test(lastError)) {
  console.log(
    '\n  A usage cap is the ACCOUNT allowance for the period, not the per-15-minute\n' +
      '  rate limit. Polling more slowly will not clear it; only the reset will.',
  );
}

console.log('');
db.close();
