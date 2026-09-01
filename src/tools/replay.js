/**
 * Runs fixtures/replay-posts.json through the full pipeline against a throwaway
 * in-memory database, then prints what happened.
 *
 *   npm run replay
 *
 * This is guaranteed free and offline: no X API call, no Anthropic call, no
 * email, no push. It exercises parse -> dedupe -> claim notices -> match ->
 * send -> notify with the network edges stubbed out.
 *
 * NOTE ON IMPORT ORDER: every import below is dynamic and deliberately so.
 * `import` statements are hoisted and evaluated BEFORE any top-level code, so
 * setting process.env at the top of the file with static imports would happen
 * too late — config.js would already have read the real values. That bug
 * previously made this script capable of sending real email when DRY_RUN=false.
 */

// Must be set before anything imports config.js.
process.env.DRY_RUN = 'true';
// Force the regex parser. Replay must never spend Anthropic credits.
process.env.ANTHROPIC_API_KEY = '';

const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const { config, KNOWN_AREAS } = await import('../config.js');
const { openDatabase, SKIP_REASON_LABELS } = await import('../db.js');
const { updateSettings } = await import('../settings.js');
const { ingestPost, runClaimSweep, hydrate } = await import('../pipeline.js');
const { recentErrors } = await import('../errors.js');

// Belt and braces: if anything above failed to take effect, stop rather than
// risk emailing the driving school from a test script.
if (!config.dryRun) {
  console.error('Refusing to run: DRY_RUN did not take effect. This script must never send email.');
  process.exit(1);
}

const fixturePath = path.resolve(config.root, process.argv[2] ?? 'fixtures/replay-posts.json');

if (!fs.existsSync(fixturePath)) {
  console.error(`No fixture at ${fixturePath}`);
  process.exit(1);
}

const posts = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const db = openDatabase(':memory:');

// Wide-open settings so the replay shows what the parser and matcher can do,
// not what your current criteria happen to filter out.
updateSettings(db, {
  scriptEnabled: true,
  areas: KNOWN_AREAS,
  timeRangeStart: '06:00',
  timeRangeEnd: '23:00',
  dateRangeStart: null,
  dateRangeEnd: null,
  overrunBufferMinutes: 30,
});

console.log(`\nReplaying ${posts.length} posts from ${path.basename(fixturePath)}`);
console.log('(regex parser only, no network calls)\n');

// Fixture posts carry no created_at so the scenario always plays out relative
// to today — otherwise "today" in the fixture text would drift into the past
// and the lessons would fall out of the claim sweep.
const baseTime = Date.now();

for (const [i, raw] of posts.entries()) {
  const post = {
    ...raw,
    created_at: raw.created_at ?? new Date(baseTime + i * 60_000).toISOString(),
  };
  const result = await ingestPost(db, post);
  const preview = raw.text.length > 68 ? `${raw.text.slice(0, 65)}...` : raw.text;
  console.log(`  ${String(result.status).padEnd(18)} ${preview}`);
}

const tally = await runClaimSweep(db);
console.log(`\nSweep: sent=${tally.sent} skipped=${tally.skipped} failed=${tally.failed}\n`);

const lessons = db.prepare('SELECT * FROM lessons ORDER BY lesson_date, start_time').all().map(hydrate);

console.log('Lessons extracted:');
for (const l of lessons) {
  const when = `${l.lesson_date} ${l.start_time}${l.end_time ? `-${l.end_time}` : ''}`;
  const why = l.skip_reason ? ` (${SKIP_REASON_LABELS[l.skip_reason] ?? l.skip_reason})` : '';
  console.log(`  ${when.padEnd(24)} ${l.areas.join('/').padEnd(20)} ${l.status}${why}`);
}

const errors = recentErrors(db);
if (errors.length) {
  console.log('\nErrors logged:');
  for (const e of errors) console.log(`  [${e.stage}] ${e.message}`);
}

console.log('\n(DRY RUN — nothing was emailed or pushed, and no API credits were used.)\n');
db.close();
