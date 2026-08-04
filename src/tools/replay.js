/**
 * Runs fixtures/replay-posts.json through the full pipeline against a throwaway
 * in-memory database, then prints what happened. No X API calls, no credits
 * spent, no emails sent (DRY_RUN is forced on regardless of your .env).
 *
 *   npm run replay
 */
process.env.DRY_RUN = 'true';

import fs from 'node:fs';
import path from 'node:path';
import { config, KNOWN_AREAS } from '../config.js';
import { openDatabase } from '../db.js';
import { updateSettings } from '../settings.js';
import { ingestPost, runClaimSweep, hydrate } from '../pipeline.js';
import { recentErrors } from '../errors.js';
import { SKIP_REASON_LABELS } from '../db.js';

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

console.log(`\nReplaying ${posts.length} posts from ${path.basename(fixturePath)}\n`);

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
  const preview = raw.text.length > 68 ? `${post.text.slice(0, 65)}...` : post.text;
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

console.log('\n(DRY RUN — nothing was actually emailed or pushed.)\n');
db.close();
