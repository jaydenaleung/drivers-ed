import { KNOWN_AREAS } from './config.js';

/** Reads the single settings row, with JSON columns already decoded. */
export function getSettings(db) {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  if (!row) throw new Error('settings row is missing — was the database initialised?');

  return {
    scriptEnabled: Boolean(row.script_enabled),
    areas: safeParseAreas(row.areas),
    timeRangeStart: row.time_range_start,
    timeRangeEnd: row.time_range_end,
    dateRangeStart: row.date_range_start || null,
    dateRangeEnd: row.date_range_end || null,
    overrunBufferMinutes: row.overrun_buffer_minutes ?? 30,
    updatedAt: row.updated_at,
  };
}

function safeParseAreas(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop anything that isn't one of the seven known towns, so a hand-edited
    // database can't smuggle in an area the dashboard can't display.
    return parsed.filter((a) => KNOWN_AREAS.includes(a));
  } catch {
    return [];
  }
}

/**
 * Applies a partial settings update. Only recognised keys are written, so a
 * crafted form POST can't set arbitrary columns.
 */
export function updateSettings(db, patch) {
  const current = getSettings(db);
  const next = { ...current, ...patch };

  const errors = validateSettings(next);
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.validationErrors = errors;
    throw err;
  }

  db.prepare(
    `UPDATE settings SET
       script_enabled         = ?,
       areas                  = ?,
       time_range_start       = ?,
       time_range_end         = ?,
       date_range_start       = ?,
       date_range_end         = ?,
       overrun_buffer_minutes = ?,
       updated_at             = datetime('now')
     WHERE id = 1`,
  ).run(
    next.scriptEnabled ? 1 : 0,
    JSON.stringify(next.areas.filter((a) => KNOWN_AREAS.includes(a))),
    next.timeRangeStart,
    next.timeRangeEnd,
    next.dateRangeStart || null,
    next.dateRangeEnd || null,
    Number(next.overrunBufferMinutes),
  );

  return getSettings(db);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateSettings(s) {
  const errors = [];

  if (!TIME_RE.test(s.timeRangeStart ?? '')) errors.push('Start time must be HH:MM');
  if (!TIME_RE.test(s.timeRangeEnd ?? '')) errors.push('End time must be HH:MM');
  if (TIME_RE.test(s.timeRangeStart ?? '') && TIME_RE.test(s.timeRangeEnd ?? '')) {
    if (s.timeRangeStart >= s.timeRangeEnd) {
      errors.push('Start time must be earlier than end time');
    }
  }

  if (s.dateRangeStart && !DATE_RE.test(s.dateRangeStart)) {
    errors.push('Start date must be YYYY-MM-DD');
  }
  if (s.dateRangeEnd && !DATE_RE.test(s.dateRangeEnd)) {
    errors.push('End date must be YYYY-MM-DD');
  }
  if (s.dateRangeStart && s.dateRangeEnd && s.dateRangeStart > s.dateRangeEnd) {
    errors.push('Start date must not be after end date');
  }

  if (!Array.isArray(s.areas)) errors.push('Areas must be a list');

  const buffer = Number(s.overrunBufferMinutes);
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 180) {
    errors.push('Overrun buffer must be a whole number of minutes between 0 and 180');
  }

  return errors;
}
