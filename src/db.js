import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, KNOWN_AREAS } from './config.js';

/**
 * The full status set from INSTRUCTIONS.md §4. Deliberately narrow: the
 * *specific* reason for a skip lives in lessons.skip_reason, not in the status.
 */
export const LESSON_STATUSES = [
  'open',
  'claimed_by_school',
  'sending',
  'email_sent',
  'skipped_no_match',
  'skipped_already_claimed',
  'error',
];

/** Specific skip reasons (§5). Stored in lessons.skip_reason. */
export const SKIP_REASONS = {
  SCRIPT_OFF: 'script_off',
  WRONG_AREA: 'wrong_area',
  WRONG_TIME: 'wrong_time',
  WRONG_DATE: 'wrong_date',
  ALREADY_CLAIMED: 'already_claimed',
  ALREADY_EMAILED: 'already_emailed',
  // One post can offer a dozen hours. We claim at most one of them, or the
  // school receives a burst of emails for what is really a single request.
  SIBLING_CLAIMED: 'sibling_claimed',
  // The bot is enabled, but the clock is outside the active-hours window.
  OUTSIDE_ACTIVE_HOURS: 'outside_active_hours',
};

/** Human-readable labels for the dashboard. */
export const SKIP_REASON_LABELS = {
  script_off: 'Bot was switched off',
  wrong_area: 'Area not selected',
  wrong_time: 'Outside your time range',
  wrong_date: 'Outside your date range',
  already_claimed: 'School announced it was already claimed',
  already_emailed: 'Already emailed for this lesson',
  sibling_claimed: 'Another hour from the same post was claimed',
  outside_active_hours: 'Outside the bot’s active hours',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),
  script_enabled         INTEGER NOT NULL DEFAULT 0,
  areas                  TEXT    NOT NULL DEFAULT '[]',
  time_range_start       TEXT    NOT NULL DEFAULT '09:00',
  time_range_end         TEXT    NOT NULL DEFAULT '21:00',
  date_range_start       TEXT,
  date_range_end         TEXT,
  overrun_buffer_minutes INTEGER NOT NULL DEFAULT 30,
  -- Active-hours window: when set, the bot only polls X and only claims during
  -- these hours. Stored as local wall-clock time in config.timezone.
  active_window_enabled  INTEGER NOT NULL DEFAULT 0,
  active_start           TEXT    NOT NULL DEFAULT '07:00',
  active_end             TEXT    NOT NULL DEFAULT '21:00',
  updated_at             TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts_seen (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT NOT NULL UNIQUE,
  post_text  TEXT NOT NULL,
  posted_at  TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  parser     TEXT,
  parsed     TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_date     TEXT NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT,
  areas           TEXT NOT NULL DEFAULT '[]',
  source_post_ids TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN (${LESSON_STATUSES.map((s) => `'${s}'`).join(', ')})),
  skip_reason     TEXT,
  email_sent_at   TEXT,
  -- Canonical "date + start_time + areas" identity from §4. A UNIQUE index on
  -- this is what actually stops the same lesson being processed twice when the
  -- school posts about it more than once.
  dedupe_key      TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lessons_date_status ON lessons (lesson_date, status);
CREATE INDEX IF NOT EXISTS idx_lessons_created ON lessons (created_at DESC);

CREATE TABLE IF NOT EXISTS errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  stage       TEXT NOT NULL,
  message     TEXT NOT NULL,
  raw_context TEXT
);

CREATE INDEX IF NOT EXISTS idx_errors_occurred ON errors (occurred_at DESC);

-- Small key/value scratch space for loop bookkeeping: since_id, last poll
-- timestamp, last poll error. Kept out of settings so the dashboard form and
-- the polling loop never write to the same row.
CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/**
 * Opens (creating if needed) the SQLite database and applies the schema.
 * Safe to call repeatedly — every statement is IF NOT EXISTS.
 */
export function openDatabase(dbPath = config.databasePath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);
  // WAL lets the dashboard read while the polling loop writes.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than throw if a write briefly overlaps.
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  seedSettings(db);
  return db;
}

/**
 * Columns added after the first release.
 *
 * The schema above is all `CREATE TABLE IF NOT EXISTS`, which does exactly
 * nothing to a table that already exists — so a database created before a
 * column was added would never grow it, and every read of that column would
 * throw. This closes that gap for the database already running on the server.
 *
 * Each entry must have a constant DEFAULT: SQLite requires one for
 * ALTER TABLE ADD COLUMN on a NOT NULL column.
 */
const MIGRATIONS = [
  ['settings', 'active_window_enabled', "INTEGER NOT NULL DEFAULT 0"],
  ['settings', 'active_start', "TEXT NOT NULL DEFAULT '07:00'"],
  ['settings', 'active_end', "TEXT NOT NULL DEFAULT '21:00'"],
];

function migrate(db) {
  for (const [table, column, definition] of MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Inserts the single settings row on first run. Never overwrites it. */
function seedSettings(db) {
  const existing = db.prepare('SELECT id FROM settings WHERE id = 1').get();
  if (existing) return;

  db.prepare(
    `INSERT INTO settings
       (id, script_enabled, areas, time_range_start, time_range_end,
        date_range_start, date_range_end, overrun_buffer_minutes)
     VALUES (1, 0, ?, '09:00', '21:00', NULL, NULL, 30)`,
  ).run(JSON.stringify(KNOWN_AREAS));
}

// --- state helpers ---------------------------------------------------------

export function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setState(db, key, value) {
  db.prepare(
    `INSERT INTO state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value === null || value === undefined ? null : String(value));
}

export const STATE_KEYS = {
  SINCE_ID: 'x_since_id',
  LAST_POLL_OK_AT: 'last_successful_poll_at',
  LAST_POLL_ERROR: 'last_poll_error',
  // Billable X reads, counted per UTC day. X bills per post returned, and its
  // own billing window is a UTC day, so this matches how the money is spent.
  READS_DAY: 'x_reads_utc_day',
  READS_COUNT: 'x_reads_today',
  // Rate caps as X itself reported them on the last response, so the dashboard
  // can show measured numbers instead of figures copied from the docs.
  RATE_CAPS: 'x_rate_caps',
  RATE_CAPS_AT: 'x_rate_caps_at',
};
