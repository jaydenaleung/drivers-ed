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

export function recentErrors(db, limit = 100) {
  return db
    .prepare('SELECT * FROM errors ORDER BY occurred_at DESC, id DESC LIMIT ?')
    .all(limit);
}

/** Used by the dashboard "clear" button so an old failure stops nagging. */
export function clearErrors(db) {
  db.prepare('DELETE FROM errors').run();
}
