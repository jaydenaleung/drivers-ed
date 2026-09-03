import { config } from '../config.js';
import { getState, setState, STATE_KEYS } from '../db.js';
import { capsFromHeaders } from '../capacity.js';

/**
 * X API v2 user-timeline poller (INSTRUCTIONS.md §3).
 *
 * NOT VERIFIED AGAINST THE LIVE API — no request has been made with a real
 * bearer token. Request shape follows the current X API v2 docs. See README.md
 * "What is untested".
 *
 * Billing note: X bills per *resource returned*, so a poll that finds nothing
 * new costs nothing. The rate limit on this endpoint is 10,000 requests per
 * 15 minutes for an app-only bearer token, so even a 5-second interval (180
 * requests) uses under 2% of it.
 */

const API_BASE = 'https://api.x.com/2';

/** Thrown when X says the prepaid credit balance is exhausted. */
export class CreditsDepletedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreditsDepletedError';
    this.isCreditsDepleted = true;
  }
}

/** Thrown on HTTP 429 so the loop can back off instead of hammering. */
export class RateLimitedError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.name = 'RateLimitedError';
    this.resetAt = resetAt;
  }
}

/**
 * Thrown when X reports "usage cap exceeded".
 *
 * This arrives as an HTTP 429 but it is NOT the ordinary per-15-minute rate
 * limit, and treating it as one was a real fault: a 60-second backoff against a
 * cap that resets daily or monthly just retries uselessly, and the dashboard
 * described the bot as "rate limited" when it was actually blind. The cap is on
 * the ACCOUNT's usage allowance, so nothing the bot does clears it — only time,
 * or buying more capacity.
 */
export class UsageCapError extends Error {
  constructor(message, { period = null, scope = null, resetAt = null } = {}) {
    super(message);
    this.name = 'UsageCapError';
    this.isUsageCap = true;
    this.period = period;
    this.scope = scope;
    this.resetAt = resetAt;
  }
}

/** Thrown when a request hangs past the timeout instead of failing outright. */
export class RequestTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RequestTimeoutError';
  }
}

/** Thrown when today's billable reads hit MAX_POSTS_PER_DAY. */
export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpendCapError';
    this.isSpendCap = true;
  }
}

/** X's own billing window is a UTC day, so count against the same boundary. */
function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Records the rate caps X described on this response.
 *
 * The dashboard's "how many hours can this run" note is only worth trusting if
 * the caps behind it are the real ones. Rather than hardcoding numbers from the
 * docs and hoping they still hold, we read whatever X puts in the response
 * headers and prefer that. A response carrying no such headers leaves the last
 * known values alone — an absent header is not evidence the cap changed.
 */
export function recordRateCaps(db, headers, now = new Date()) {
  const caps = capsFromHeaders(headers);
  if (caps.length === 0) return null;
  setState(db, STATE_KEYS.RATE_CAPS, JSON.stringify(caps));
  setState(db, STATE_KEYS.RATE_CAPS_AT, now.toISOString());
  return caps;
}

/** The caps from the most recent poll, or [] if none have been seen yet. */
export function observedRateCaps(db) {
  try {
    const parsed = JSON.parse(getState(db, STATE_KEYS.RATE_CAPS) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Billable reads so far today, resetting automatically at UTC midnight. */
export function readsToday(db, now = new Date()) {
  const day = utcDay(now);
  if (getState(db, STATE_KEYS.READS_DAY) !== day) return 0;
  return Number(getState(db, STATE_KEYS.READS_COUNT, '0')) || 0;
}

/** Adds to today's tally, rolling the counter over at UTC midnight. */
export function recordReads(db, count, now = new Date()) {
  const day = utcDay(now);
  const current = readsToday(db, now);
  setState(db, STATE_KEYS.READS_DAY, day);
  setState(db, STATE_KEYS.READS_COUNT, String(current + count));
  return current + count;
}

/**
 * Fetches posts newer than the stored since_id.
 *
 * First run behaviour: with no stored since_id we do NOT process what comes
 * back. We record the newest id and return nothing. Otherwise the very first
 * poll would treat days-old posts as fresh openings and fire off claim emails
 * for lessons that are long gone.
 *
 * @returns {Promise<{posts: Array, primed: boolean}>} posts oldest-first
 */
export async function fetchNewPosts(db, { fetchImpl = fetch, now = new Date() } = {}) {
  // Spend guard. X charges per post RETURNED, so the danger is not the polling
  // frequency (idle polls are free) but a fault that makes every poll return a
  // full batch — a since_id cursor that stops advancing, say. At a 10s interval
  // that is 8,640 polls a day, so an unbounded fault would be expensive. This
  // stops the loop long before that and surfaces it on the dashboard.
  const used = readsToday(db, now);
  if (used >= config.maxPostsPerDay) {
    throw new SpendCapError(
      `Daily X read cap reached: ${used}/${config.maxPostsPerDay} posts (about ` +
        `$${(used * 0.005).toFixed(2)}). Polling is paused until UTC midnight. ` +
        `Raise MAX_POSTS_PER_DAY if this is legitimate volume, or investigate — ` +
        `normal usage is roughly 10 posts a day.`,
    );
  }

  const sinceId = getState(db, STATE_KEYS.SINCE_ID);
  const isFirstRun = !sinceId;

  const url = new URL(`${API_BASE}/users/${config.x.accountUserId}/tweets`);
  url.searchParams.set('max_results', isFirstRun ? '5' : '100');
  url.searchParams.set('tweet.fields', 'created_at,text');
  url.searchParams.set('exclude', 'retweets');
  if (sinceId) url.searchParams.set('since_id', sinceId);

  // A request with no deadline can hang indefinitely, and a hung request inside
  // the polling loop is invisible: no error is thrown, so nothing is logged and
  // nothing is retried. The bot simply stops watching and says nothing about it.
  // That is exactly the 14-hour outage on 2 Sep 2026 — the last log line was a
  // 429, and then silence until a manual restart, while six real posts went by.
  // Every request now has a deadline it cannot outlive.
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.x.bearerToken}`,
        'User-Agent': 'drivers-ed-bot/1.0',
      },
      signal: AbortSignal.timeout(config.x.requestTimeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new RequestTimeoutError(
        `X API did not respond within ${config.x.requestTimeoutMs / 1000}s — treating as a failed ` +
          `poll and retrying. (X was serving Cloudflare 524s around the 2 Sep outage.)`,
      );
    }
    throw err;
  }

  const body = await readBody(response);

  // Before the status check: a 429 is precisely when the cap headers matter
  // most, and throwing first would discard them.
  recordRateCaps(db, response.headers, now);

  if (!response.ok) {
    throw toApiError(response, body);
  }

  const posts = Array.isArray(body?.data) ? body.data : [];

  // Count what we were actually billed for: posts returned, not requests made.
  if (posts.length > 0) recordReads(db, posts.length, now);
  // X returns newest-first; process oldest-first so a lesson posted and then
  // claimed in the same batch is seen in the order it actually happened.
  const ordered = [...posts].reverse();

  const newestId = body?.meta?.newest_id ?? highestId(posts);
  if (newestId) setState(db, STATE_KEYS.SINCE_ID, newestId);
  setState(db, STATE_KEYS.LAST_POLL_OK_AT, new Date().toISOString());
  setState(db, STATE_KEYS.LAST_POLL_ERROR, null);

  if (isFirstRun) {
    return { posts: [], primed: true };
  }

  return {
    posts: ordered.map((p) => ({
      id: String(p.id),
      text: p.text ?? '',
      created_at: p.created_at ?? null,
    })),
    primed: false,
  };
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON. This is usually a Cloudflare interstitial, which is a full HTML
    // page — and the whole thing used to end up in the error message, then in
    // the journal, then in the dashboard banner. Keep enough to identify it and
    // throw the markup away.
    return { _raw: summarise(text) };
  }
}

/** Reduces an HTML error page to a single identifying line. */
function summarise(text) {
  const cloudflare = text.match(/Error\s*(\d{3})/i) ?? text.match(/error code:\s*(\d+)/i);
  const title = text.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (cloudflare || /cloudflare/i.test(text)) {
    return `Cloudflare error page${cloudflare ? ` (${cloudflare[1]})` : ''}${
      title ? `: ${title[1].trim()}` : ''
    } — this is X's edge failing, not an API response.`;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * The rate-limit state X reported, rendered for a log line.
 *
 * The 2 Sep outage could not be diagnosed from the journal because the only
 * thing recorded was the string "usage cap exceeded" — every number X sent
 * alongside it was discarded. Now the numbers go in the message.
 */
export function describeLimits(headers) {
  if (!headers || typeof headers.get !== 'function') return '';

  const parts = [];
  for (const [name, label] of [
    ['x-rate-limit-limit', '15min limit'],
    ['x-rate-limit-remaining', 'remaining'],
    ['x-rate-limit-reset', 'resets'],
    ['x-app-limit-24hour-limit', '24h limit'],
    ['x-app-limit-24hour-remaining', '24h remaining'],
    ['x-user-limit-24hour-limit', 'user 24h limit'],
    ['x-user-limit-24hour-remaining', 'user 24h remaining'],
  ]) {
    const value = headers.get(name);
    if (value === null || value === undefined || value === '') continue;
    // The reset header is a unix timestamp; a human needs the clock time.
    if (name.endsWith('-reset')) {
      const at = new Date(Number(value) * 1000);
      parts.push(`${label} ${Number.isNaN(at.getTime()) ? value : at.toISOString()}`);
    } else {
      parts.push(`${label} ${value}`);
    }
  }

  return parts.length ? ` [${parts.join(', ')}]` : ' [X sent no rate-limit headers]';
}

function toApiError(response, body) {
  const detail =
    body?.detail || body?.title || body?.errors?.[0]?.message || body?._raw || response.statusText;
  const asText = JSON.stringify(body ?? '');

  // X returns this when the prepaid credit balance runs out. It is the failure
  // mode most likely to silently blind the bot, so it gets its own type and a
  // dedicated dashboard banner.
  if (/CreditsDepleted|insufficient credit|payment required/i.test(asText) || response.status === 402) {
    return new CreditsDepletedError(
      `X API credits are exhausted — the bot is blind until you top up. (${detail})`,
    );
  }

  if (response.status === 429) {
    const resetHeader = response.headers?.get?.('x-rate-limit-reset') ?? null;
    const limits = describeLimits(response.headers);

    // "Usage cap exceeded" is a 429, but it is not the per-15-minute request
    // limit — it is the account's usage allowance for the period, and no amount
    // of backing off within the hour will clear it. Calling it "rate limited"
    // sent us looking at the poll interval when the poll interval was innocent.
    if (/usage cap|UsageCapExceeded/i.test(asText)) {
      const period = body?.period ?? body?.errors?.[0]?.period ?? null;
      const scope = body?.scope ?? body?.errors?.[0]?.scope ?? null;
      return new UsageCapError(
        `X API usage cap exceeded${period ? ` (${period} cap` : ''}${
          scope ? `, ${scope} scope)` : period ? ')' : ''
        } — the bot is BLIND until the cap resets. ${detail}${limits}`,
        { period, scope, resetAt: resetHeader },
      );
    }

    return new RateLimitedError(`X API rate limited: ${detail}${limits}`, resetHeader);
  }

  if (response.status === 401 || response.status === 403) {
    return new Error(`X API rejected the bearer token (HTTP ${response.status}): ${detail}`);
  }

  return new Error(`X API error HTTP ${response.status}: ${detail}`);
}

/** Post IDs are numeric strings that can exceed Number.MAX_SAFE_INTEGER. */
function highestId(posts) {
  let best = null;
  for (const p of posts) {
    const id = String(p.id);
    if (best === null || compareIds(id, best) > 0) best = id;
  }
  return best;
}

export function compareIds(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
