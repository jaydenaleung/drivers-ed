import { KNOWN_AREAS } from '../config.js';

/**
 * Date/time normalisation shared by both parsers (regex and Haiku), so that
 * whichever one produced a result, downstream code sees identical shapes:
 * dates as YYYY-MM-DD and times as 24-hour HH:MM.
 */

const MONTHS = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Current date in the given IANA timezone, as YYYY-MM-DD. */
export function todayInTz(timezone, now = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is exactly what we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Shifts a YYYY-MM-DD string by whole days without any timezone drift. */
export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function isValidDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '')) return false;
  const [y, m, d] = dateStr.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTime(mins) {
  const wrapped = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Picks a calendar year for a bare "July 27th" with no year attached.
 * A date more than 6 months in the past is assumed to mean next year — that
 * only matters around New Year, but it's cheap to get right.
 */
function inferYear(month, day, todayStr) {
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const candidate = new Date(Date.UTC(ty, month - 1, day));
  const today = new Date(Date.UTC(ty, tm - 1, td));
  const monthsAgo = (today - candidate) / (1000 * 60 * 60 * 24 * 30.44);
  if (monthsAgo > 6) return ty + 1;
  if (monthsAgo < -6) return ty - 1;
  return ty;
}

/**
 * Extracts a lesson date from free text.
 * Handles: "today", "tonight", "tomorrow", "July 27th", "Jul 27", "7/27",
 * "7/27/2026". Returns YYYY-MM-DD or null.
 */
export function parseDateExpression(
  text,
  { timezone = 'America/New_York', now = new Date(), postedOnDate = null } = {},
) {
  // "Today" means the day the POST was published, not the day we happen to be
  // reading it. Without this, a post made at 11:55pm and polled at 12:01am
  // would be filed under the wrong date and never match.
  const today = postedOnDate ?? todayInTz(timezone, now);
  const lower = text.toLowerCase();

  // An explicit calendar date always beats a relative word, because posts
  // routinely say "Lesson Open Today July 27th" — both are present and the
  // explicit one is unambiguous.
  const monthNames = Object.keys(MONTHS).join('|');
  const named = lower.match(
    new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`),
  );
  if (named) {
    const month = MONTHS[named[1]];
    const day = Number(named[2]);
    const year = named[3] ? Number(named[3]) : inferYear(month, day, today);
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isValidDate(iso)) return iso;
  }

  // Numeric: 7/27 or 7/27/2026 or 7-27-2026. Requires a separator that isn't
  // part of a time range, so we demand a slash for the bare two-part form.
  const numeric = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    let year;
    if (numeric[3]) {
      year = Number(numeric[3]);
      if (year < 100) year += 2000;
    } else {
      year = inferYear(month, day, today);
    }
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (isValidDate(iso)) return iso;
  }

  if (/\btomorrow\b/.test(lower)) return addDays(today, 1);
  if (/\b(today|tonight|this (?:afternoon|morning|evening))\b/.test(lower)) return today;

  return null;
}

/**
 * Resolves a 12-hour clock reading to 24-hour "HH:MM".
 * @param {number} hour 1-12 (or 0-23 if already 24h)
 * @param {number} minute
 * @param {'am'|'pm'|null} meridiem
 */
function to24(hour, minute, meridiem) {
  let h = hour;
  if (meridiem === 'pm' && h < 12) h += 12;
  else if (meridiem === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Guesses am/pm for a bare hour using driving-school hours: 8-11 is morning,
 * 12 is noon, 1-7 is afternoon/evening.
 */
function guessMeridiem(hour) {
  if (hour === 12) return 'pm';
  if (hour >= 8 && hour <= 11) return 'am';
  if (hour >= 1 && hour <= 7) return 'pm';
  return null; // already unambiguous (0, or 13-23)
}

/**
 * Extracts a start/end time range from free text.
 * Handles "1-2 pm", "1:30-3pm", "10 am - 12 pm", "1 pm to 2 pm", "10-12".
 * Returns { start, end } as HH:MM strings, or nulls.
 */
export function parseTimeRange(text) {
  const re = new RegExp(
    String.raw`\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*(?:-|–|—|to|until|till)\s*` +
      String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?`,
    'i',
  );
  const m = text.match(re);
  if (!m) return parseSingleTime(text);

  const startHour = Number(m[1]);
  const startMin = Number(m[2] ?? 0);
  let startMer = normaliseMeridiem(m[3]);
  const endHour = Number(m[4]);
  const endMin = Number(m[5] ?? 0);
  let endMer = normaliseMeridiem(m[6]);

  if (startHour > 23 || endHour > 23 || startMin > 59 || endMin > 59) return { start: null, end: null };

  // A trailing meridiem ("1-2 pm") governs both ends unless the start had its own.
  if (!endMer && startMer) endMer = startMer;
  if (!endMer) endMer = guessMeridiem(endHour);
  if (!startMer) startMer = endMer;

  let start = to24(startHour, startMin, startMer);
  const end = to24(endHour, endMin, endMer);

  // "10-12 pm" naively reads as 22:00-12:00. When the shared meridiem puts the
  // start after the end, the start must have been the other half of the day.
  if (timeToMinutes(start) >= timeToMinutes(end)) {
    const flipped = to24(startHour, startMin, startMer === 'pm' ? 'am' : 'pm');
    if (timeToMinutes(flipped) < timeToMinutes(end)) start = flipped;
  }

  if (timeToMinutes(start) >= timeToMinutes(end)) return { start: null, end: null };
  return { start, end };
}

/** Fallback for posts that name only a start time ("Lesson open at 3pm"). */
function parseSingleTime(text) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\b/i);
  if (!m) return { start: null, end: null };

  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) return { start: null, end: null };

  return { start: to24(hour, minute, normaliseMeridiem(m[3])), end: null };
}

function normaliseMeridiem(raw) {
  if (!raw) return null;
  return raw.toLowerCase().replace(/\./g, '').startsWith('p') ? 'pm' : 'am';
}

/**
 * Finds the known town names mentioned in the text. Returns them in the
 * canonical KNOWN_AREAS order so the dedupe key is stable no matter how the
 * post ordered them ("Needham/Wellesley" and "Wellesley/Needham" are one lesson).
 */
export function extractAreas(text) {
  return KNOWN_AREAS.filter((area) => new RegExp(`\\b${area}\\b`, 'i').test(text));
}

/** Canonical identity for a lesson: date + start time + sorted areas (§4). */
export function dedupeKey({ date, start_time: startTime, areas }) {
  const canonicalAreas = [...new Set(areas ?? [])].sort().join(',');
  return `${date}|${startTime}|${canonicalAreas}`;
}
