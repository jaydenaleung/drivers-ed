/**
 * End-to-end test against REAL posts from the real account.
 *
 *   npm run live-test            (10 posts)
 *   npm run live-test -- 5       (5 posts)
 *
 * What it does:
 *   - fetches the N most recent posts from the monitored X account (COSTS
 *     ~$0.005 per post returned)
 *   - runs them through the real pipeline: parse -> dedupe -> claim notices ->
 *     match -> send -> notify
 *   - sends a REAL claim email and a REAL phone push if anything matches
 *
 * Safety rails, all enforced before any send:
 *   - hard refusal if CLAIM_EMAIL_TO points at the driving school
 *   - regex parser only, so it never spends Anthropic credits
 *   - throwaway in-memory database, so the live bot's state is untouched
 *
 * Dynamic imports below are deliberate: `import` is hoisted and would run
 * before these process.env assignments, exactly the bug that once made
 * replay.js capable of sending real mail.
 */

// Force regex-only. This test must never spend Anthropic credits.
process.env.ANTHROPIC_API_KEY = '';
// We DO want real sends here — that is the point of the test.
process.env.DRY_RUN = 'false';

const { config, KNOWN_AREAS } = await import('../config.js');
const { openDatabase, SKIP_REASON_LABELS } = await import('../db.js');
const { updateSettings } = await import('../settings.js');
const { ingestPost, runClaimSweep, hydrate } = await import('../pipeline.js');
const { recentErrors } = await import('../errors.js');
const { todayInTz } = await import('../parser/normalize.js');

const SCHOOL = /needhamdrivingschool\.com/i;

// ---- safety rails ---------------------------------------------------------
if (SCHOOL.test(config.email.to)) {
  console.error(
    `\nREFUSING TO RUN.\n\n` +
      `CLAIM_EMAIL_TO is set to ${config.email.to}, which is the driving school.\n` +
      `This test sends real email. Point CLAIM_EMAIL_TO at your own address first.\n`,
  );
  process.exit(1);
}
if (config.dryRun) {
  console.error('\nDRY_RUN override failed — refusing to run a test that cannot actually send.\n');
  process.exit(1);
}

const count = Math.min(Math.max(Number.parseInt(process.argv[2] ?? '10', 10) || 10, 5), 100);

console.log('\n=== LIVE END-TO-END TEST ===\n');
console.log(`  Monitored account id : ${config.x.accountUserId}`);
console.log(`  Posts to fetch       : ${count}  (about $${(count * 0.005).toFixed(3)} of X credit)`);
console.log(`  Parser               : regex only (Anthropic disabled for this run)`);
console.log(`  Claim email goes to  : ${config.email.to}`);
console.log(`  Phone push           : ${config.ntfy.server}/<topic>`);
console.log(`  Database             : in-memory throwaway (live bot state untouched)\n`);

// ---- fetch real posts ------------------------------------------------------
const url = new URL(`https://api.x.com/2/users/${config.x.accountUserId}/tweets`);
url.searchParams.set('max_results', String(count));
url.searchParams.set('tweet.fields', 'created_at');
url.searchParams.set('exclude', 'retweets');

const res = await fetch(url, {
  headers: { Authorization: `Bearer ${config.x.bearerToken}` },
  signal: AbortSignal.timeout(20000),
});

if (!res.ok) {
  console.error(`X API returned HTTP ${res.status}:`, (await res.text()).slice(0, 300));
  process.exit(1);
}

const payload = await res.json();
const fetched = Array.isArray(payload.data) ? payload.data : [];
// X returns newest-first; replay them oldest-first so a lesson posted and then
// claimed is seen in the order it actually happened.
const posts = [...fetched].reverse().map((p) => ({
  id: String(p.id),
  text: p.text ?? '',
  created_at: p.created_at ?? null,
}));

// Save the raw posts so all further parser work can be done offline, for free,
// against real wording instead of guesses. This is the expensive part of the
// run — never throw it away.
const fsMod = (await import('node:fs')).default;
const pathMod = (await import('node:path')).default;
const archivePath = pathMod.join(config.root, 'fixtures', 'real-posts.json');
fsMod.mkdirSync(pathMod.dirname(archivePath), { recursive: true });
fsMod.writeFileSync(archivePath, `${JSON.stringify(posts, null, 2)}\n`);

console.log(`Fetched ${posts.length} real posts.`);
console.log(`Saved full text to fixtures/real-posts.json — reuse it instead of paying again.\n`);
console.log('--- What the parser made of each one ---\n');

// ---- run the pipeline ------------------------------------------------------
const db = openDatabase(':memory:');
const today = todayInTz(config.timezone, new Date());

// Wide-open criteria so the test exercises matching rather than your filters.
updateSettings(db, {
  scriptEnabled: true,
  areas: KNOWN_AREAS,
  timeRangeStart: '06:00',
  timeRangeEnd: '23:00',
  dateRangeStart: null,
  dateRangeEnd: null,
  overrunBufferMinutes: 30,
});

for (const post of posts) {
  const result = await ingestPost(db, post);
  const when = post.created_at ? post.created_at.slice(0, 10) : '??';
  const text = post.text.replace(/\s+/g, ' ');
  console.log(`  [${when}] ${result.status}`);
  console.log(`      "${text.slice(0, 96)}${text.length > 96 ? '...' : ''}"`);
}

let lessons = db.prepare('SELECT * FROM lessons ORDER BY lesson_date, start_time').all().map(hydrate);
const claimable = lessons.filter((l) => l.lesson_date >= today && l.status === 'open');

console.log(`\n--- Lessons extracted: ${lessons.length} (${claimable.length} still claimable today or later) ---\n`);
for (const l of lessons) {
  const when = `${l.lesson_date} ${l.start_time}${l.end_time ? `-${l.end_time}` : ''}`;
  const past = l.lesson_date < today ? '  (in the past)' : '';
  console.log(`  ${when.padEnd(22)} ${l.areas.join('/').padEnd(20)} ${l.status}${past}`);
}

// If every real lesson is in the past there is nothing to send, and the send
// path would go untested. Add one clearly-labelled synthetic post so the email
// and push are genuinely exercised.
if (claimable.length === 0) {
  console.log('\n  No real lesson is still claimable (they are all in the past).');
  console.log('  Injecting ONE synthetic post dated today so the send path is actually tested.\n');

  const synthetic = {
    id: `synthetic-${Date.now()}`,
    text: 'Lesson Open Today: 2-3 pm Needham/Wellesley. Email us to claim this hour.',
    created_at: new Date().toISOString(),
  };
  const r = await ingestPost(db, synthetic);
  console.log(`  [SYNTHETIC] ${r.status}  "${synthetic.text}"`);
}

if (process.argv.includes('--fetch-only')) {
  console.log('\n--fetch-only given: stopping before the claim sweep.');
  console.log('No email and no push were sent. Raw posts are in fixtures/real-posts.json.\n');
  db.close();
  process.exit(0);
}

// ---- the sweep: this is where real email and push happen -------------------
console.log('\n--- Claim sweep (REAL email and push from here) ---\n');
const tally = await runClaimSweep(db);
console.log(`  sent=${tally.sent}  skipped=${tally.skipped}  failed=${tally.failed}`);

lessons = db.prepare('SELECT * FROM lessons ORDER BY lesson_date, start_time').all().map(hydrate);

console.log('\n--- Final state ---\n');
for (const l of lessons) {
  const when = `${l.lesson_date} ${l.start_time}${l.end_time ? `-${l.end_time}` : ''}`;
  const why = l.skip_reason ? ` (${SKIP_REASON_LABELS[l.skip_reason] ?? l.skip_reason})` : '';
  const sent = l.email_sent_at ? `  emailed ${l.email_sent_at}` : '';
  console.log(`  ${when.padEnd(22)} ${l.areas.join('/').padEnd(20)} ${l.status}${why}${sent}`);
}

const errors = recentErrors(db);
if (errors.length) {
  console.log('\n--- Errors logged (these are surfaced on the dashboard) ---\n');
  for (const e of errors) console.log(`  [${e.stage}] ${e.message}`);
}

console.log('');
if (tally.sent > 0) {
  console.log(`Sent ${tally.sent} real claim email(s) to ${config.email.to}. Check your inbox and phone.`);
} else {
  console.log('No email was sent — nothing matched. See the skip reasons above.');
}
console.log('The live bot database was NOT touched; this ran entirely in memory.\n');

db.close();
