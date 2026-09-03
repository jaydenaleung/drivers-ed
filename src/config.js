import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env.local first, then .env. dotenv never overwrites a value that is
// already set, so .env.local wins where both define the same key. Either file
// on its own is fine — locally you may prefer .env.local; the systemd unit on
// the server reads .env.
const LOADED_ENV_FILES = [];
for (const name of ['.env.local', '.env']) {
  const file = path.join(ROOT, name);
  const result = dotenv.config({ path: file, quiet: true });
  if (!result.error) LOADED_ENV_FILES.push(file);
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root: ROOT,
  // Which .env file(s) were actually read. Surfaced by the diagnostics tools:
  // "the value is missing" and "you edited a different file than the one this
  // process loads" look identical without it.
  loadedEnvFiles: LOADED_ENV_FILES,

  x: {
    bearerToken: process.env.X_BEARER_TOKEN ?? '',
    accountUserId: process.env.X_ACCOUNT_USER_ID ?? '',
    // Deadline on every X request. Without one, a hung connection stalls the
    // whole polling loop silently — no throw, so no log and no retry. Twenty
    // seconds is many times the normal response time, so a request that exceeds
    // it is not slow, it is stuck.
    requestTimeoutMs: int(process.env.X_REQUEST_TIMEOUT_SECONDS, 20) * 1000,
  },

  email: {
    address: process.env.GMAIL_ADDRESS ?? '',
    appPassword: (process.env.GMAIL_APP_PASSWORD ?? '').replace(/\s+/g, ''),
    to: process.env.CLAIM_EMAIL_TO || 'info@needhamdrivingschool.com',
    fromName: process.env.CLAIM_FROM_NAME || 'Jayden Leung',
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
  },

  ntfy: {
    topic: process.env.NTFY_TOPIC ?? '',
    server: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, ''),
  },

  dashboard: {
    password: process.env.DASHBOARD_PASSWORD ?? '',
    sessionSecret: process.env.SESSION_SECRET ?? '',
  },

  port: int(process.env.PORT, 8080),
  host: process.env.HOST || '127.0.0.1',
  databasePath: path.resolve(ROOT, process.env.DATABASE_PATH || './data/driversed.db'),
  // 30s, not the 10s this used to default to. Per-window rate limits were never
  // the problem — 10s is 90 requests per 15 minutes against a measured 10,000.
  // The daily total is: 10s round the clock is 8,640 requests a day, and ~18,000
  // in a day is what X refused on 2 Sep 2026. 30s is 2,880 and costs at most 27
  // seconds of reaction time on an account that posts a few times a day.
  pollIntervalSeconds: int(process.env.POLL_INTERVAL_SECONDS, 30),
  // Hard ceiling on billable X reads per UTC day. X bills per post RETURNED,
  // so a stuck since_id cursor could in principle re-read the same batch on
  // every poll. At the default 10s interval that is 8,640 polls a day, so this
  // cap is the difference between a rounding error and a nasty surprise.
  maxPostsPerDay: int(process.env.MAX_POSTS_PER_DAY, 400),
  // Optional ceiling on REQUESTS per UTC day. 0 (the default) means no ceiling:
  // poll until X itself refuses.
  //
  // This was briefly on by default after the 2 Sep 2026 cutoff, where ~18,000
  // requests in ~15 hours of 3-second polling ended in "usage cap exceeded".
  // Turned off at Jayden's request — a self-imposed guess at a limit nobody can
  // look up mostly stops the bot from ever telling us what the real limit is.
  // Set it to a number to turn the guard back on.
  //
  // The request COUNTER is independent of this and always runs: it costs
  // nothing, and it is the only record of how many requests a cutoff took.
  maxRequestsPerDay: int(process.env.MAX_REQUESTS_PER_DAY, 0),
  timezone: process.env.TIMEZONE || 'America/New_York',

  dryRun: bool(process.env.DRY_RUN, true),
  postSource: (process.env.POST_SOURCE || 'x').toLowerCase(),
};

/** The seven towns the school serves. Order is the dashboard checkbox order. */
export const KNOWN_AREAS = [
  'Needham',
  'Dedham',
  'Dover',
  'Natick',
  'Wellesley',
  'Weston',
  'Westwood',
];

/**
 * Validates config for a real run. Returns a list of human-readable problems;
 * empty means good to go. Kept as a pure function so tests can import config
 * without a populated .env.
 */
export function validateConfig(cfg = config) {
  const problems = [];

  if (!['x', 'replay'].includes(cfg.postSource)) {
    problems.push(`POST_SOURCE must be "x" or "replay", got "${cfg.postSource}"`);
  }
  if (cfg.postSource === 'x') {
    if (!cfg.x.bearerToken) problems.push('X_BEARER_TOKEN is not set');
    if (!cfg.x.accountUserId) problems.push('X_ACCOUNT_USER_ID is not set');
    if (cfg.x.accountUserId && !/^\d+$/.test(cfg.x.accountUserId)) {
      problems.push(
        `X_ACCOUNT_USER_ID must be the numeric user ID, not a handle (got "${cfg.x.accountUserId}")`,
      );
    }
  }

  if (!cfg.dryRun) {
    if (!cfg.email.address) problems.push('GMAIL_ADDRESS is not set (required when DRY_RUN=false)');
    if (!cfg.email.appPassword) {
      problems.push('GMAIL_APP_PASSWORD is not set (required when DRY_RUN=false)');
    }
    if (!cfg.ntfy.topic) problems.push('NTFY_TOPIC is not set (required when DRY_RUN=false)');
  }

  if (!cfg.dashboard.password) problems.push('DASHBOARD_PASSWORD is not set');
  if (!cfg.dashboard.sessionSecret) {
    problems.push('SESSION_SECRET is not set (generate with: openssl rand -hex 32)');
  } else if (cfg.dashboard.sessionSecret.length < 16) {
    problems.push('SESSION_SECRET is too short — use at least 32 hex characters');
  }

  // Only genuinely unworkable values are fatal. A zero or negative interval
  // would spin the loop with no delay; anything else is a tuning choice and
  // refusing to boot over it is the wrong call — see configWarnings().
  if (!Number.isFinite(cfg.pollIntervalSeconds) || cfg.pollIntervalSeconds < 1) {
    problems.push(
      `POLL_INTERVAL_SECONDS must be a whole number of seconds, 1 or more (got "${process.env.POLL_INTERVAL_SECONDS}")`,
    );
  }

  return problems;
}

/**
 * Non-fatal notes, printed at startup. These are things worth knowing, not
 * reasons to refuse to run.
 *
 * A previous version treated POLL_INTERVAL_SECONDS below 5 as fatal, which
 * turned "I'd like to poll a bit faster" into a service that would not boot.
 * Three seconds is 300 requests per 15 minutes against a 10,000 limit, and
 * polls that return nothing are not billed — so it is a preference, not a
 * fault.
 */
export function configWarnings(cfg = config) {
  const warnings = [];

  if (cfg.pollIntervalSeconds < 5) {
    warnings.push(
      `POLL_INTERVAL_SECONDS is ${cfg.pollIntervalSeconds}s. That is fine — it uses about ` +
        `${Math.round((900 / cfg.pollIntervalSeconds / 10000) * 100)}% of the X rate limit and ` +
        `idle polls are free — but going below ~2s buys you nothing measurable.`,
    );
  }

  if (!cfg.dryRun && /needhamdrivingschool\.com/i.test(cfg.email.to)) {
    warnings.push(`LIVE: claim emails will go to the driving school (${cfg.email.to}).`);
  }

  return warnings;
}

/** True when the Haiku parser is usable; otherwise the bot is regex-only. */
export function haikuEnabled(cfg = config) {
  return Boolean(cfg.anthropic.apiKey);
}
