import { config, validateConfig, haikuEnabled } from './config.js';
import { openDatabase, setState, STATE_KEYS } from './db.js';
import { logError, STAGES } from './errors.js';
import { fetchNewPosts, CreditsDepletedError, RateLimitedError } from './x/client.js';
import { fetchReplayPosts } from './x/replay.js';
import { ingestPost, runClaimSweep } from './pipeline.js';
import { createServer } from './web/server.js';

/**
 * Single-process entrypoint (INSTRUCTIONS.md §3): one background polling loop
 * and one web server, sharing one SQLite file, supervised by systemd.
 */

const db = openDatabase();
let running = true;
let consecutiveFailures = 0;

function banner() {
  console.log('--- drivers-ed lesson bot ---');
  console.log(`  post source     : ${config.postSource}`);
  console.log(`  poll interval   : ${config.pollIntervalSeconds}s`);
  console.log(`  parser          : ${haikuEnabled(config) ? 'Haiku + regex fallback' : 'regex only'}`);
  console.log(`  dry run         : ${config.dryRun ? 'YES — no email or push will be sent' : 'no'}`);
  console.log(`  database        : ${config.databasePath}`);
  console.log(`  dashboard       : http://${config.host}:${config.port}`);
  console.log('-----------------------------');
}

function startup() {
  const problems = validateConfig();
  if (problems.length) {
    console.error('Configuration problems:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nFix these in your .env file (see .env.example). Refusing to start.');
    process.exit(1);
  }

  if (!haikuEnabled(config)) {
    console.warn('ANTHROPIC_API_KEY is not set — running regex-only. Unusual wording may be missed.');
  }
  if (config.dryRun) {
    console.warn('DRY_RUN is on — the bot will NOT send claim emails. Set DRY_RUN=false to go live.');
  }
}

/** One full cycle: fetch new posts, ingest them, then sweep for claimables. */
async function cycle() {
  const source = config.postSource === 'replay' ? fetchReplayPosts : fetchNewPosts;

  let batch;
  try {
    batch = await source(db);
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures += 1;
    setState(db, STATE_KEYS.LAST_POLL_ERROR, err.message);
    logError(db, STAGES.POLL, err, { consecutiveFailures });

    // Credit exhaustion and rate limiting are not transient — hammering makes
    // them worse and, for credits, costs nothing but noise. Back off hard.
    if (err instanceof CreditsDepletedError) return { backoffSeconds: 300 };
    if (err instanceof RateLimitedError) return { backoffSeconds: 60 };

    // Exponential backoff on anything else, capped at a minute.
    return { backoffSeconds: Math.min(60, 2 ** Math.min(consecutiveFailures, 6)) };
  }

  if (batch.primed) {
    console.log('First run — recorded the current newest post and skipped it. Now watching for new posts.');
  }

  for (const post of batch.posts) {
    try {
      const result = await ingestPost(db, post);
      console.log(`[post ${post.id}] ${result.status}`);
    } catch (err) {
      logError(db, STAGES.PARSE, err, { postId: post.id });
    }
  }

  try {
    const tally = await runClaimSweep(db);
    if (tally.sent || tally.failed) {
      console.log(`[sweep] sent=${tally.sent} skipped=${tally.skipped} failed=${tally.failed}`);
    }
  } catch (err) {
    logError(db, STAGES.MATCH, err);
  }

  return { backoffSeconds: config.pollIntervalSeconds };
}

async function loop() {
  while (running) {
    let waitSeconds = config.pollIntervalSeconds;
    try {
      const result = await cycle();
      waitSeconds = result.backoffSeconds;
    } catch (err) {
      // Nothing in the pipeline is allowed to kill the loop (§3).
      logError(db, STAGES.MATCH, err, { note: 'unexpected error in cycle' });
    }
    await sleep(waitSeconds * 1000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function main() {
  startup();
  banner();

  const server = createServer(db).listen(config.port, config.host, () => {
    console.log(`Dashboard listening on http://${config.host}:${config.port}`);
  });

  loop();

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down.`);
    running = false;
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Don't hang forever if a request is in flight.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash here would take the bot silently offline, so record it before
  // letting systemd restart the process.
  process.on('unhandledRejection', (reason) => {
    logError(db, STAGES.MATCH, reason instanceof Error ? reason : String(reason), {
      note: 'unhandledRejection',
    });
  });
}

main();
