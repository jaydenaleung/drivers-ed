/**
 * Central error sink. Per INSTRUCTIONS.md §3, every failure is written here and
 * the loop keeps going — nothing in the pipeline is allowed to kill the process.
 */

export const STAGES = {
  POLL: 'poll',
  PARSE: 'parse',
  MATCH: 'match',
  EMAIL: 'email',
  NOTIFY: 'notify',
};

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} stage one of STAGES
 * @param {unknown} error Error object or message string
 * @param {unknown} [context] anything JSON-serialisable; stored for debugging
 */
export function logError(db, stage, error, context) {
  const message = error instanceof Error ? error.message : String(error);
  let raw = null;

  try {
    raw = JSON.stringify(
      {
        context: context ?? null,
        stack: error instanceof Error ? error.stack : null,
      },
      null,
      2,
    );
  } catch {
    raw = String(context);
  }

  try {
    db.prepare('INSERT INTO errors (stage, message, raw_context) VALUES (?, ?, ?)').run(
      stage,
      message,
      raw,
    );
  } catch (dbErr) {
    // If we can't even write the error row, stderr is the last resort. Never
    // throw from the error logger — that would take down the polling loop.
    console.error(`[${stage}] ${message} (also failed to persist: ${dbErr.message})`);
    return;
  }

  console.error(`[${stage}] ${message}`);
}

/**
 * Logs an error only if the identical message has not been recorded in the
 * last `windowMinutes`.
 *
 * A persistent fault — an invalid Anthropic key, say — otherwise produces one
 * row per post and buries every genuine error under a wall of duplicates. The
 * fault is still reported; it just is not reported a hundred times.
 */
export function logErrorOnce(db, stage, error, context, windowMinutes = 60) {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const seen = db
      .prepare(
        `SELECT id FROM errors
          WHERE stage = ? AND message = ?
            AND occurred_at > datetime('now', ?)
          LIMIT 1`,
      )
      .get(stage, message, `-${windowMinutes} minutes`);

    if (seen) return;
  } catch {
    // If the lookup fails for any reason, fall through and log normally —
    // losing an error is worse than logging a duplicate.
  }

  logError(db, stage, error, context);
}

export function recentErrors(db, limit = 100) {
  return db
    .prepare('SELECT * FROM errors ORDER BY occurred_at DESC, id DESC LIMIT ?')
    .all(limit);
}

/** Used by the dashboard "clear" button so an old failure stops nagging. */
export function clearErrors(db) {
  db.prepare('DELETE FROM errors').run();
}
