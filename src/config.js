import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  x: {
    bearerToken: process.env.X_BEARER_TOKEN ?? '',
    accountUserId: process.env.X_ACCOUNT_USER_ID ?? '',
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
  pollIntervalSeconds: int(process.env.POLL_INTERVAL_SECONDS, 10),
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

  if (cfg.pollIntervalSeconds < 5) {
    problems.push('POLL_INTERVAL_SECONDS below 5 is needlessly aggressive; use 5 or more');
  }

  return problems;
}

/** True when the Haiku parser is usable; otherwise the bot is regex-only. */
export function haikuEnabled(cfg = config) {
  return Boolean(cfg.anthropic.apiKey);
}
