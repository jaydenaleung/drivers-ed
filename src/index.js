import { config, validateConfig, configWarnings, haikuEnabled } from './config.js';
import { openDatabase, getState, setState, STATE_KEYS } from './db.js';
import { logError, STAGES } from './errors.js';
import {
  fetchNewPosts,
  CreditsDepletedError,
  RateLimitedError,
  SpendCapError,
  UsageCapError,
  RequestBudgetError,
} from './x/client.js';
import { fetchReplayPosts } from './x/replay.js';
import { ingestPost, runClaimSweep } from './pipeline.js';
import { createServer } from './web/server.js';
import { getSettings } from './settings.js';
import { withinWindow } from './capacity.js';
import { nowMinutesInTz } from './parser/normalize.js';

/**
 * Single-process entrypoint (INSTRUCTIONS.md §3): one background polling loop
 * and one web server, sharing one SQLite file, supervised by systemd.
 */

const db = openDatabase();
let running = true;
let consecutiveFailures = 0;
// Only logged on change — a line every poll would bury everything else.
let lastWindowState = null;

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
    console.error('Configuration problems — refusing to start:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      `\nConfig was read from: ${config.loadedEnvFiles.join(', ') || 'NO .env FILE FOUND in ' + config.root}`,
    );
    console.error('Fix that file, then: sudo systemctl restart drivers-ed');
    // Exit 78 (EX_CONFIG), not 1. The unit file sets RestartPreventExitStatus=78
    // so systemd stops immediately with this message visible in `systemctl
    // status`, instead of restart-looping every 5s on a fault no restart can fix.
    process.exit(78);
  }

  for (const w of configWarnings()) console.warn(`Note: ${w}`);

  if (!haikuEnabled(config)) {
    console.warn('ANTHROPIC_API_KEY is not set — running regex-only. Unusual wording may be missed.');
  }
  if (config.dryRun) {
    console.warn('DRY_RUN is on — the bot will NOT send claim emails. Set DRY_RUN=false to go live.');
  }
}

/**
 * Is the active-hours window open right now?
 *
 * Read fresh every cycle rather than cached at startup, so changing the window
 * on the dashboard takes effect on the next poll instead of at the next restart.
 */
function activeNow() {
  const settings = getSettings(db);
  if (!settings.activeWindowEnabled) return true;
  return withinWindow(nowMinutesInTz(config.timezone, new Date()), settings.activeStart, settings.activeEnd);
}

/** One full cycle: fetch new posts, ingest them, then sweep for claimables. */
async function cycle() {
  const source = config.postSource === 'replay' ? fetchReplayPosts : fetchNewPosts;

  // Outside the active window we skip the FETCH — that is the call that spends
  // rate-limit quota, and skipping it is the entire point of the window. The
  // sweep below still runs: it is local, free, and it is what records
  // "outside active hours" against the lessons so the dashboard can explain
  // itself rather than going quietly blank.
  const windowOpen = activeNow();
  if (windowOpen !== lastWindowState) {
    const settings = getSettings(db);
    if (settings.activeWindowEnabled) {
      console.log(
        windowOpen
          ? `[window] Active hours started (${settings.activeStart}–${settings.activeEnd} ${config.timezone}) — polling X.`
          : `[window] Outside active hours (${settings.activeStart}–${settings.activeEnd} ${config.timezone}) — not polling X.`,
      );
    }
    lastWindowState = windowOpen;
  }

  let batch = { posts: [], primed: false };
  try {
    if (windowOpen) {
      batch = await source(db);
      consecutiveFailures = 0;
    }
  } catch (err) {
    consecutiveFailures += 1;
    setState(db, STATE_KEYS.LAST_POLL_ERROR, err.message);
    logError(db, STAGES.POLL, err, { consecutiveFailures });

    // Credit exhaustion and rate limiting are not transient — hammering makes
    // them worse and, for credits, costs nothing but noise. Back off hard.
    if (err instanceof CreditsDepletedError) return { windowOpen, backoffSeconds: 300 };
    // A usage cap is measured in days or months, not minutes. Retrying every
    // minute against it is pure noise; ten minutes still notices the reset
    // promptly without filling the journal with the same line 800 times.
    if (err instanceof UsageCapError) return { windowOpen, backoffSeconds: 600 };
    if (err instanceof RateLimitedError) return { windowOpen, backoffSeconds: 60 };
    // The cap clears at UTC midnight; re-checking every 10 minutes is plenty
    // and keeps the log readable.
    if (err instanceof SpendCapError) return { windowOpen, backoffSeconds: 600 };
    // Same story: the budget clears at UTC midnight, so poll the clock, not X.
    if (err instanceof RequestBudgetError) return { windowOpen, backoffSeconds: 600 };

    // Exponential backoff on anything else, capped at a minute.
    return { windowOpen, backoffSeconds: Math.min(60, 2 ** Math.min(consecutiveFailures, 6)) };
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

  return { windowOpen, backoffSeconds: config.pollIntervalSeconds };
}

/**
 * Says out loud that the bot is not seeing anything.
 *
 * On 2 Sep 2026 the bot went 14.6 hours without a successful poll and the
 * journal contained NOTHING for that whole period — the last line was a 429 and
 * the next was a manual restart. Six real posts went past unseen. Silence is
 * indistinguishable from working normally, which made a total outage look like
 * a quiet day. So: while the active window is open and polls are not landing,
 * complain on a schedule.
 */
const BLIND_WARN_AFTER_MS = 15 * 60 * 1000;
let lastBlindWarnAt = 0;

function warnIfBlind(windowOpen) {
  if (!windowOpen) return;

  const lastOk = getState(db, STATE_KEYS.LAST_POLL_OK_AT);
  const blindFor = lastOk ? Date.now() - new Date(lastOk).getTime() : Infinity;
  if (!(blindFor > BLIND_WARN_AFTER_MS)) return;
  if (Date.now() - lastBlindWarnAt < BLIND_WARN_AFTER_MS) return;

  lastBlindWarnAt = Date.now();
  const forHuman = Number.isFinite(blindFor) ? `${(blindFor / 3600000).toFixed(1)}h` : 'the whole run';
  console.error(
    `[blind] No successful poll for ${forHuman}. The bot is NOT seeing new posts. ` +
      `Last error: ${getState(db, STATE_KEYS.LAST_POLL_ERROR) ?? 'none recorded'}`,
  );
}

async function loop() {
  while (running) {
    let waitSeconds = config.pollIntervalSeconds;
    try {
      const result = await cycle();
      waitSeconds = result.backoffSeconds;
      warnIfBlind(result.windowOpen);
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
