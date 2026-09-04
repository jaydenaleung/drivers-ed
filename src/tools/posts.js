/**
 * Lists every post the bot has polled, with when it was published.
 *
 *   npm run posts                 newest 50, one line each
 *   npm run posts -- --all        every post on record
 *   npm run posts -- --limit=200
 *   npm run posts -- --full       the complete text of each post
 *   npm run posts -- --json       machine-readable, for piping
 *   npm run posts -- --oldest     oldest first instead of newest first
 *
 * Reads the database only. No API call, no cost, works while capped.
 */
import { config } from '../config.js';
import { openDatabase } from '../db.js';
import { postIdToDate, LATE_MINUTES } from '../diagnostics.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const ALL = flag('all');
const LIMIT = ALL ? -1 : Number(value('limit', 50));
const FULL = flag('full');
const JSON_OUT = flag('json');
const OLDEST = flag('oldest');

const db = openDatabase();

const rows = db
  .prepare(
    `SELECT post_id, post_text, posted_at, fetched_at, parser, parsed
       FROM posts_seen
      ORDER BY COALESCE(posted_at, fetched_at) ${OLDEST ? 'ASC' : 'DESC'}
      ${LIMIT > 0 ? 'LIMIT ?' : ''}`,
  )
  .all(...(LIMIT > 0 ? [LIMIT] : []));

/** SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC; X sends ISO-8601 with a Z. */
function toDate(v) {
  if (!v) return null;
  const d = new Date(/[TZ]/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local wall-clock in the configured timezone — lessons are local events. */
function local(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(d)
    .replace(',', '');
}

const utc = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function describe(parsedJson) {
  try {
    const p = JSON.parse(parsedJson ?? 'null');
    if (!p) return '';
    if (p.is_claim_notice) return 'claim notice';
    if (p.is_lesson_opening) {
      const n = (p.lessons ?? []).length;
      return n ? `${n} lesson${n === 1 ? '' : 's'}` : 'opening';
    }
    return 'not a lesson';
  } catch {
    return '';
  }
}

// SQL ordered by the stored timestamp; re-sort here so a post whose time was
// recovered from its ID lands in its true position rather than by when we read
// it. The SQL ORDER BY still decides which rows a --limit selects.
const records = rows
  .map(toRecord)
  .sort((a, b) => (OLDEST ? a.published - b.published : b.published - a.published));

function toRecord(r) {
  // Prefer what X told us; fall back to the timestamp inside the ID itself.
  const stored = toDate(r.posted_at);
  const fromId = postIdToDate(r.post_id);
  const published = stored ?? fromId;
  const fetched = toDate(r.fetched_at);

  return {
    post_id: r.post_id,
    published,
    published_source: stored ? 'created_at' : fromId ? 'derived from post ID' : 'unknown',
    fetched,
    lag_seconds: published && fetched ? Math.round((fetched - published) / 1000) : null,
    parser: r.parser ?? null,
    kind: describe(r.parsed),
    text: r.post_text ?? '',
  };
}

// --- output -----------------------------------------------------------------

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      records.map((r) => ({
        ...r,
        published: r.published ? r.published.toISOString() : null,
        published_local: r.published ? local(r.published) : null,
        fetched: r.fetched ? r.fetched.toISOString() : null,
      })),
      null,
      2,
    ),
  );
  db.close();
  process.exit(0);
}

const total = db.prepare('SELECT COUNT(*) n FROM posts_seen').get().n;

console.log(
  `\n${records.length} of ${total} polled post(s)` +
    `${LIMIT > 0 && total > records.length ? ` — newest first, use --all for the rest` : ''}\n`,
);

if (records.length === 0) {
  console.log('  Nothing polled yet.\n');
  db.close();
  process.exit(0);
}

if (FULL) {
  for (const r of records) {
    console.log('─'.repeat(72));
    console.log(`  ${r.post_id}`);
    console.log(`  posted   ${r.published ? `${utc(r.published)} UTC   ${local(r.published)} ${config.timezone}` : 'unknown'}`);
    if (r.published_source !== 'created_at') console.log(`           (${r.published_source})`);
    console.log(`  read     ${r.fetched ? `${utc(r.fetched)} UTC` : 'unknown'}${
      r.lag_seconds === null ? '' : `   ${formatLag(r.lag_seconds)} later`
    }`);
    console.log(`  parsed   ${r.parser ?? '—'}${r.kind ? ` → ${r.kind}` : ''}`);
    console.log('');
    for (const line of r.text.split('\n')) console.log(`    ${line}`);
    console.log('');
  }
} else {
  // The timezone name sets the column width — "America/New_York" is wider than
  // the timestamps beneath it, and a fixed width ran the header into the next
  // column.
  const localHeader = `posted (${config.timezone})`;
  const localWidth = Math.max(21, localHeader.length + 2);

  console.log(`  ${'posted (UTC)'.padEnd(21)}${localHeader.padEnd(localWidth)}${'lag'.padEnd(9)}post`);
  console.log(`  ${'─'.repeat(51 + localWidth)}`);
  for (const r of records) {
    const when = r.published ? utc(r.published) : 'unknown';
    const whenLocal = r.published ? local(r.published) : '';
    const lag = r.lag_seconds === null ? '' : formatLag(r.lag_seconds);
    const preview = r.text.replace(/\s+/g, ' ').trim().slice(0, 60);
    console.log(
      `  ${when.padEnd(21)}${whenLocal.padEnd(localWidth)}${lag.padEnd(9)}${preview}${
        r.text.length > 60 ? '…' : ''
      }`,
    );
  }
  console.log('\n  --full for complete text and post IDs, --json to pipe elsewhere.');
}

// A post read long after publication is a period the bot was not watching.
const late = records.filter((r) => r.lag_seconds !== null && r.lag_seconds > LATE_MINUTES * 60);
if (late.length) {
  console.log(
    `\n  ${late.length} post(s) above were read more than ${LATE_MINUTES} minutes after publication —\n` +
      `  run \`npm run diagnose\` for what the bot was doing at the time.`,
  );
}

console.log('');
db.close();

function formatLag(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
