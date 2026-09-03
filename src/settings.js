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
    activeWindowEnabled: Boolean(row.active_window_enabled),
    activeStart: row.active_start || '07:00',
    activeEnd: row.active_end || '21:00',
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

  // A key that isn't in the patch keeps its current value. Without this, a form
  // POST that omits a field — an older client, a curl, a form rendered before a
  // new field existed — would spread `undefined` over the stored value and fail
  // validation on a setting the caller never touched. An explicitly invalid
  // value is still rejected; only absence is ignored.
  const supplied = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = { ...current, ...supplied };

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
       active_window_enabled  = ?,
       active_start           = ?,
       active_end             = ?,
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
    next.activeWindowEnabled ? 1 : 0,
    next.activeStart,
    next.activeEnd,
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

  // Active hours. Unlike the lesson time range, a window that crosses midnight
  // is legitimate (22:00 to 06:00 is eight hours), so there is deliberately no
  // "start must be before end" rule here.
  if (!TIME_RE.test(s.activeStart ?? '')) errors.push('Active hours start must be HH:MM');
  if (!TIME_RE.test(s.activeEnd ?? '')) errors.push('Active hours end must be HH:MM');
  if (s.activeWindowEnabled && s.activeStart === s.activeEnd) {
    errors.push(
      'Active hours start and end are the same. Untick "Only run during these hours" to run all day.',
    );
  }

  const buffer = Number(s.overrunBufferMinutes);
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 180) {
    errors.push('Overrun buffer must be a whole number of minutes between 0 and 180');
  }

  return errors;
}
