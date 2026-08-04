import { SKIP_REASONS } from './db.js';
import { timeToMinutes } from './parser/normalize.js';

/**
 * Decides whether a lesson should be claimed (INSTRUCTIONS.md §5).
 *
 * Pure function — no database, no clock, no I/O — so every branch is directly
 * testable and the pipeline can call it inside a transaction without surprises.
 *
 * Jayden's confirmed rules:
 *  - AREA: match if ANY of the lesson's towns is selected.
 *  - TIME: the lesson is assumed to run past its stated end (lessons overrun),
 *    so the effective window is [start, end + overrunBufferMinutes]. That WHOLE
 *    window must fit entirely inside the selected time range.
 *  - DATE: inside the selected range; an unset bound means unbounded.
 *
 * @returns {{ matches: boolean, skipReason: string|null, effectiveEnd: string|null }}
 */
export function evaluateLesson(lesson, settings) {
  // --- state checks first: these describe the lesson, not the criteria ------
  if (lesson.status === 'claimed_by_school') {
    return skip(SKIP_REASONS.ALREADY_CLAIMED);
  }
  if (lesson.status === 'email_sent' || lesson.status === 'sending' || lesson.email_sent_at) {
    return skip(SKIP_REASONS.ALREADY_EMAILED);
  }
  if (!settings.scriptEnabled) {
    return skip(SKIP_REASONS.SCRIPT_OFF);
  }

  // --- criteria checks ------------------------------------------------------
  const areas = Array.isArray(lesson.areas) ? lesson.areas : [];
  const selected = Array.isArray(settings.areas) ? settings.areas : [];
  const areaMatches = areas.some((a) => selected.includes(a));
  if (!areaMatches) {
    return skip(SKIP_REASONS.WRONG_AREA);
  }

  if (!dateInRange(lesson.lesson_date, settings.dateRangeStart, settings.dateRangeEnd)) {
    return skip(SKIP_REASONS.WRONG_DATE);
  }

  const window = effectiveWindow(lesson, settings.overrunBufferMinutes ?? 30);
  if (!window) {
    return skip(SKIP_REASONS.WRONG_TIME);
  }

  const rangeStart = timeToMinutes(settings.timeRangeStart);
  const rangeEnd = timeToMinutes(settings.timeRangeEnd);

  // "Entirely inside" — both ends, not just the start.
  if (window.startMinutes < rangeStart || window.endMinutes > rangeEnd) {
    return skip(SKIP_REASONS.WRONG_TIME, window.endLabel);
  }

  return { matches: true, skipReason: null, effectiveEnd: window.endLabel };
}

function skip(reason, effectiveEnd = null) {
  return { matches: false, skipReason: reason, effectiveEnd };
}

/**
 * The window we actually protect: the stated lesson plus the overrun buffer.
 * A lesson with no end time is assumed to run one hour — the school's own
 * wording is "claim this hour".
 *
 * Returns minutes-from-midnight (which may exceed 1440 for a late lesson, in
 * which case it simply cannot fit inside any same-day range — that is correct,
 * not a bug).
 */
export function effectiveWindow(lesson, bufferMinutes) {
  if (!lesson.start_time) return null;

  const startMinutes = timeToMinutes(lesson.start_time);
  if (!Number.isFinite(startMinutes)) return null;

  const statedEnd = lesson.end_time ? timeToMinutes(lesson.end_time) : startMinutes + 60;
  if (!Number.isFinite(statedEnd) || statedEnd <= startMinutes) return null;

  const endMinutes = statedEnd + bufferMinutes;

  return {
    startMinutes,
    endMinutes,
    endLabel: formatMinutes(endMinutes),
  };
}

/** Unlike minutesToTime(), this does NOT wrap — 25:00 must stay visible. */
function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function dateInRange(date, start, end) {
  if (!date) return false;
  if (start && date < start) return false;
  if (end && date > end) return false;
  return true;
}
