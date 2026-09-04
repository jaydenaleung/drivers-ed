import { SKIP_REASONS } from './db.js';
import { getSettings } from './settings.js';
import { logError, logErrorOnce, STAGES } from './errors.js';
import { evaluateLesson } from './matcher.js';
import { parsePost as defaultParsePost } from './parser/index.js';
import { sendClaimEmail as defaultSendEmail } from './email.js';
import { notifyClaimSent as defaultNotify } from './notify.js';
import { dedupeKey, todayInTz, nowMinutesInTz } from './parser/normalize.js';
import { config } from './config.js';

/**
 * The processing pipeline (INSTRUCTIONS.md §3, §5).
 *
 * Split into two phases on purpose:
 *
 *  1. ingestPost()      — record the post, parse it, apply claim notices,
 *                         upsert any lesson it describes. No email.
 *  2. runClaimSweep()   — look at every still-claimable lesson and decide
 *                         whether to email.
 *
 * The sweep is separate because §6 requires a failed email to be retried on the
 * next cycle, and because changing your settings should re-open a lesson that
 * was skipped a minute ago for the wrong reason. Matching only at post-arrival
 * time could do neither.
 */

/** Dependencies are injected so tests can run the whole chain without network. */
function defaultDeps() {
  return {
    parsePost: defaultParsePost,
    sendClaimEmail: defaultSendEmail,
    notify: defaultNotify,
    now: () => new Date(),
    timezone: config.timezone,
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — ingest
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{status: string, lessonId?: number, parsed?: object}>}
 */
export async function ingestPost(db, post, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };

  // INSERT OR IGNORE is the dedupe: a post we have already handled is a no-op,
  // even if the poller hands it to us twice.
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO posts_seen (post_id, post_text, posted_at, poll_interval_seconds)
       VALUES (?, ?, ?, ?)`,
    )
    .run(post.id, post.text, post.created_at ?? null, config.pollIntervalSeconds);

  if (inserted.changes === 0) {
    return { status: 'duplicate_post' };
  }

  const postedOnDate = postDate(post, deps);

  let result;
  try {
    result = await deps.parsePost(post.text, {
      now: deps.now(),
      timezone: deps.timezone,
      postedOnDate,
    });
  } catch (err) {
    logError(db, STAGES.PARSE, err, { postId: post.id, text: post.text });
    return { status: 'parse_failed' };
  }

  const { parsed, parser, haikuError } = result;

  if (haikuError) {
    // A broken key or a down API fails on EVERY post. Log it once an hour so
    // the fault is visible without burying real errors under duplicates.
    logErrorOnce(db, STAGES.PARSE, `Haiku parser failed, used regex instead: ${haikuError}`, {
      postId: post.id,
    });
  }

  db.prepare('UPDATE posts_seen SET parser = ?, parsed = ? WHERE post_id = ?').run(
    parser,
    JSON.stringify(parsed),
    post.id,
  );

  if (parsed.is_claim_notice) {
    const affected = applyClaimNotice(db, parsed, postedOnDate);
    return { status: 'claim_notice', affected, parsed };
  }

  if (!parsed.is_lesson_opening) {
    return { status: 'not_a_lesson', parsed };
  }

  // A real opening post describes SEVERAL lessons, one per line — e.g.
  // "8 am, 9 am, 10 am or 11 am - Needham, Westwood or Dover" is four separate
  // claimable hours, and the next line is a different set again.
  const offered = parsed.lessons ?? [];

  if (!parsed.date || offered.length === 0) {
    // An opening we could not pin down is worth surfacing — it may be a real
    // lesson the parser choked on, which is exactly the case we must not lose.
    logError(
      db,
      STAGES.PARSE,
      'Post looks like a lesson opening but no usable date/time could be extracted',
      { postId: post.id, text: post.text, parsed },
    );
    return { status: 'incomplete_lesson', parsed };
  }

  const lessonIds = offered.map((lesson) =>
    upsertLesson(
      db,
      {
        date: parsed.date,
        start_time: lesson.start_time,
        end_time: lesson.end_time,
        areas: lesson.areas,
      },
      post.id,
    ),
  );

  return {
    status: 'lesson_recorded',
    lessonIds,
    count: lessonIds.length,
    parsed,
  };
}

/** The lesson date a bare "today" refers to: the post's own publish date. */
function postDate(post, deps) {
  const source = post.created_at ? new Date(post.created_at) : deps.now();
  const valid = Number.isNaN(source.getTime()) ? deps.now() : source;
  return todayInTz(deps.timezone, valid);
}

/**
 * Inserts the lesson, or attaches this post to the existing row if we have
 * seen the same date+time+areas before. The UNIQUE index on dedupe_key is what
 * actually guarantees one row per lesson (§4).
 */
export function upsertLesson(db, parsed, postId) {
  const key = dedupeKey(parsed);
  const areasJson = JSON.stringify(parsed.areas ?? []);

  const existing = db.prepare('SELECT id, source_post_ids FROM lessons WHERE dedupe_key = ?').get(key);

  if (existing) {
    const ids = safeJsonArray(existing.source_post_ids);
    if (!ids.includes(postId)) {
      ids.push(postId);
      db.prepare("UPDATE lessons SET source_post_ids = ?, updated_at = datetime('now') WHERE id = ?").run(
        JSON.stringify(ids),
        existing.id,
      );
    }
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO lessons
         (lesson_date, start_time, end_time, areas, source_post_ids, status, dedupe_key)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(parsed.date, parsed.start_time, parsed.end_time ?? null, areasJson, JSON.stringify([postId]), key);

  return info.lastInsertRowid;
}

/**
 * Applies a claim notice (§5).
 *
 * Only rows still in a claimable state are flipped. A lesson we already
 * emailed for keeps its `email_sent` status — the school announcing it is
 * claimed does not erase the fact that we sent the email, and overwriting it
 * would make the dashboard lie about what happened.
 */
export function applyClaimNotice(db, parsed, fallbackDate) {
  const date = parsed.date ?? fallbackDate;
  if (!date) return 0;

  const claimable = "status IN ('open', 'skipped_no_match')";

  // Keep the reason WE decided not to claim it, if we had already decided one.
  //
  // status and skip_reason answer different questions. The status is a fact
  // about the lesson — the school gave it away. skip_reason answers the
  // dashboard's actual column heading, "why not claimed", which is about our
  // decision. Overwriting one with the other told Jayden the school had taken
  // lessons that were never candidates: they were in towns he had not selected,
  // and had already been skipped as wrong_area before any notice arrived. The
  // school then claims the whole date, and every one of those rows gets
  // relabelled. Only a lesson with no recorded reason — one we never got to —
  // is genuinely unclaimed *because* the school took it.
  const keepOurReason = `CASE WHEN skip_reason IS NULL THEN ? ELSE skip_reason END`;

  if (parsed.is_blanket_claim || !parsed.start_time) {
    const info = db
      .prepare(
        `UPDATE lessons
            SET status = 'claimed_by_school',
                skip_reason = ${keepOurReason},
                updated_at = datetime('now')
          WHERE lesson_date = ? AND ${claimable}`,
      )
      .run(SKIP_REASONS.ALREADY_CLAIMED, date);
    return info.changes;
  }

  // A specific claim notice. Match on date + start time; if the notice names
  // towns, require an overlap so a 1pm Needham claim does not also kill a
  // separate 1pm Natick lesson.
  const candidates = db
    .prepare(`SELECT id, areas FROM lessons WHERE lesson_date = ? AND start_time = ? AND ${claimable}`)
    .all(date, parsed.start_time);

  const noticeAreas = parsed.areas ?? [];
  let changed = 0;

  const flip = db.prepare(
    `UPDATE lessons SET status = 'claimed_by_school', skip_reason = ${keepOurReason},
            updated_at = datetime('now')
      WHERE id = ?`,
  );

  for (const row of candidates) {
    const lessonAreas = safeJsonArray(row.areas);
    const overlaps =
      noticeAreas.length === 0 ||
      lessonAreas.length === 0 ||
      lessonAreas.some((a) => noticeAreas.includes(a));

    if (overlaps) {
      flip.run(SKIP_REASONS.ALREADY_CLAIMED, row.id);
      changed += 1;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Phase 2 — claim sweep
// ---------------------------------------------------------------------------

/**
 * Evaluates every still-claimable lesson and emails the ones that match.
 * @returns {Promise<{sent: number, skipped: number, failed: number}>}
 */
export async function runClaimSweep(db, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const settings = getSettings(db);
  const today = todayInTz(deps.timezone, deps.now());
  const nowMinutes = nowMinutesInTz(deps.timezone, deps.now());

  // Past lessons can never be claimed, so they drop out of the sweep and it
  // stays O(today's lessons) rather than growing forever.
  const rows = db
    .prepare(
      `SELECT * FROM lessons
        WHERE status IN ('open', 'skipped_no_match')
          AND lesson_date >= ?
        ORDER BY lesson_date, start_time`,
    )
    .all(today);

  const tally = { sent: 0, skipped: 0, failed: 0, emails: 0 };
  const matching = [];

  for (const row of rows) {
    const lesson = hydrate(row);
    const verdict = evaluateLesson(lesson, settings, nowMinutes);

    if (!verdict.matches) {
      recordSkip(db, lesson.id, verdict.skipReason);
      tally.skipped += 1;
      continue;
    }

    matching.push(lesson);
  }

  if (matching.length === 0) return tally;

  // Every matching lesson goes into ONE email, comma-separated. A post can
  // advertise a dozen hours and several may fit the criteria; sending one email
  // each would be a burst of requests for what is really one conversation.
  const outcome = await claimLessons(db, matching, deps);

  if (outcome.result === 'sent') {
    tally.sent = outcome.lessons.length;
    tally.emails = 1;
  } else if (outcome.result === 'failed') {
    tally.failed = outcome.lessons.length;
  } else {
    tally.skipped += matching.length;
  }

  return tally;
}

/**
 * Records why a lesson was not claimed, without closing the door on it: the
 * status stays re-evaluatable so flipping a setting can still rescue the
 * lesson while it is open. `already_claimed` is terminal.
 */
function recordSkip(db, lessonId, reason) {
  const status =
    reason === SKIP_REASONS.ALREADY_CLAIMED ? 'skipped_already_claimed' : 'skipped_no_match';

  db.prepare(
    `UPDATE lessons SET status = ?, skip_reason = ?, updated_at = datetime('now')
      WHERE id = ? AND status IN ('open', 'skipped_no_match')`,
  ).run(status, reason, lessonId);
}

/**
 * THE RACE-SAFETY STEP (§5).
 *
 * The UPDATE ... WHERE status IN ('open','skipped_no_match') is a single atomic
 * statement: SQLite either flips exactly this row to 'sending' or reports zero
 * changes. Zero changes means something else already took it, so we do not send.
 * Because better-sqlite3 is synchronous there is no await between the read and
 * the write — no second copy of this code can interleave and produce a second
 * email for the same lesson.
 *
 * The email itself is deliberately sent AFTER the flip and outside any
 * transaction: holding a write lock across a network call would block the
 * dashboard, and an open transaction cannot make an already-sent email unsent.
 */
async function claimLessons(db, lessons, deps) {
  // Flip EVERY lesson in the batch to 'sending' inside ONE SQLite transaction.
  // better-sqlite3 transactions are synchronous, so there is no await between
  // the check and the write and no second copy of this code can interleave.
  // A lesson whose UPDATE matched zero rows was taken by someone else and is
  // simply left out of the email.
  const claimAll = db.transaction((candidates) => {
    const flip = db.prepare(
      `UPDATE lessons SET status = 'sending', updated_at = datetime('now')
        WHERE id = ? AND status IN ('open', 'skipped_no_match')`,
    );
    return candidates.filter((l) => flip.run(l.id).changes === 1);
  });

  const claimed = claimAll(lessons);

  if (claimed.length === 0) {
    return { result: 'lost_race', lessons: [] };
  }

  const ids = claimed.map((l) => l.id);
  const placeholders = ids.map(() => '?').join(', ');

  let sendResult;
  try {
    // One email covering every claimed lesson, comma-separated.
    sendResult = await deps.sendClaimEmail(claimed);
  } catch (err) {
    // §6: never lose a real opening to a transient SMTP error. Put the whole
    // batch back to 'open' so the next sweep retries it.
    db.prepare(
      `UPDATE lessons SET status = 'open', skip_reason = NULL, updated_at = datetime('now')
        WHERE id IN (${placeholders}) AND status = 'sending'`,
    ).run(...ids);
    logError(db, STAGES.EMAIL, err, { lessonIds: ids, lessons: claimed });
    return { result: 'failed', lessons: claimed };
  }

  // Only now, with SMTP confirmed, are the lessons recorded as claimed.
  db.prepare(
    `UPDATE lessons SET status = 'email_sent', skip_reason = NULL,
            email_sent_at = datetime('now'), updated_at = datetime('now')
      WHERE id IN (${placeholders})`,
  ).run(...ids);

  // §7: a notification failure must not undo any of the above.
  try {
    const notified = await deps.notify(claimed);
    if (!notified?.ok) {
      logError(db, STAGES.NOTIFY, notified?.error ?? 'ntfy push failed', { lessonIds: ids });
    }
  } catch (err) {
    logError(db, STAGES.NOTIFY, err, { lessonIds: ids });
  }

  const summary = claimed
    .map((l) => `${l.lesson_date} ${l.start_time} ${l.areas.join('/')}`)
    .join(', ');
  console.log(
    `[claim] one email claiming ${claimed.length} lesson(s): ${summary} ` +
      `(messageId ${sendResult?.messageId ?? 'n/a'})`,
  );

  return { result: 'sent', lessons: claimed };
}

/** Decodes the JSON columns on a lessons row. */
export function hydrate(row) {
  return {
    ...row,
    areas: safeJsonArray(row.areas),
    source_post_ids: safeJsonArray(row.source_post_ids),
  };
}

function safeJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
