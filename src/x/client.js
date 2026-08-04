import { config } from '../config.js';
import { getState, setState, STATE_KEYS } from '../db.js';

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
 * Fetches posts newer than the stored since_id.
 *
 * First run behaviour: with no stored since_id we do NOT process what comes
 * back. We record the newest id and return nothing. Otherwise the very first
 * poll would treat days-old posts as fresh openings and fire off claim emails
 * for lessons that are long gone.
 *
 * @returns {Promise<{posts: Array, primed: boolean}>} posts oldest-first
 */
export async function fetchNewPosts(db, { fetchImpl = fetch } = {}) {
  const sinceId = getState(db, STATE_KEYS.SINCE_ID);
  const isFirstRun = !sinceId;

  const url = new URL(`${API_BASE}/users/${config.x.accountUserId}/tweets`);
  url.searchParams.set('max_results', isFirstRun ? '5' : '100');
  url.searchParams.set('tweet.fields', 'created_at,text');
  url.searchParams.set('exclude', 'retweets');
  if (sinceId) url.searchParams.set('since_id', sinceId);

  const response = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${config.x.bearerToken}`,
      'User-Agent': 'drivers-ed-bot/1.0',
    },
  });

  const body = await readBody(response);

  if (!response.ok) {
    throw toApiError(response, body);
  }

  const posts = Array.isArray(body?.data) ? body.data : [];
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
    return { _raw: text };
  }
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
    const resetHeader = response.headers?.get?.('x-rate-limit-reset');
    return new RateLimitedError(`X API rate limited: ${detail}`, resetHeader ?? null);
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
