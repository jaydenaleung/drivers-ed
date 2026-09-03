import { timeToMinutes } from './parser/normalize.js';

/**
 * How many hours a day can the bot actually poll before an X API cap stops it?
 *
 * This exists to answer one question honestly on the dashboard: if you set an
 * active window of, say, 07:00–21:00 (14 hours), can the API sustain 14 hours
 * of polling at your chosen interval, or will it cut out partway through?
 *
 * ---------------------------------------------------------------------------
 * The arithmetic
 * ---------------------------------------------------------------------------
 * Every X rate cap has the same shape: at most `limit` requests per rolling
 * `windowSeconds`. Polling every P seconds spends one request per P seconds, so
 * a full bucket lasts `limit x P` seconds.
 *
 *   - If limit x P >= windowSeconds, the bucket refills faster than we drain it
 *     and the cap NEVER binds — the bot can poll continuously, forever.
 *   - If limit x P <  windowSeconds, we drain it early and stall until the
 *     window resets. Over a long run that is a duty cycle of
 *     (limit x P) / windowSeconds, i.e. 24 x that many hours of polling a day.
 *
 * Taking the minimum duty cycle across every cap gives the hours-per-day figure.
 *
 * ---------------------------------------------------------------------------
 * What is NOT modelled here, and why
 * ---------------------------------------------------------------------------
 * X bills per post RETURNED, not per request made. A poll that finds nothing
 * new is free. So neither the prepaid credit balance nor MAX_POSTS_PER_DAY is a
 * function of the poll interval — they cap how many *posts* can be read in a
 * day, which no amount of extra polling changes. They are reported separately
 * by the dashboard rather than folded into the hours figure, because rolling
 * them in would produce a number that looks like an answer but isn't.
 */

/** A cap X publishes for this endpoint that we have not measured ourselves. */
export const DOCUMENTED_CAPS = [
  {
    id: 'requests_15min',
    label: 'Requests per 15 minutes',
    limit: 10000,
    windowSeconds: 900,
    source: 'documented',
  },
];

/**
 * Response headers X may send describing a cap. Only the ones actually present
 * on a real response are used — nothing here is assumed to exist.
 *
 * `x-rate-limit-*` is the standard trio on v2 endpoints and confirms the
 * 15-minute cap from the API's own mouth. The 24-hour headers appear on some
 * endpoints and not others; if this endpoint sends them, that cap becomes real
 * and is folded into the calculation automatically.
 */
export const HEADER_CAPS = [
  {
    id: 'requests_15min',
    label: 'Requests per 15 minutes',
    windowSeconds: 900,
    limitHeader: 'x-rate-limit-limit',
    remainingHeader: 'x-rate-limit-remaining',
  },
  {
    id: 'app_24hour',
    label: 'App requests per 24 hours',
    windowSeconds: 86400,
    limitHeader: 'x-app-limit-24hour-limit',
    remainingHeader: 'x-app-limit-24hour-remaining',
  },
  {
    id: 'user_24hour',
    label: 'User requests per 24 hours',
    windowSeconds: 86400,
    limitHeader: 'x-user-limit-24hour-limit',
    remainingHeader: 'x-user-limit-24hour-remaining',
  },
];

/**
 * Pulls whichever caps X actually described on a response. Returns [] when the
 * response carried none — which is a real and expected outcome, not an error.
 */
export function capsFromHeaders(headers) {
  if (!headers || typeof headers.get !== 'function') return [];

  const found = [];
  for (const spec of HEADER_CAPS) {
    const limit = Number(headers.get(spec.limitHeader));
    if (!Number.isFinite(limit) || limit <= 0) continue;

    const remainingRaw = headers.get(spec.remainingHeader);
    const remaining = Number(remainingRaw);

    found.push({
      id: spec.id,
      label: spec.label,
      limit,
      windowSeconds: spec.windowSeconds,
      remaining: Number.isFinite(remaining) && remainingRaw !== null ? remaining : null,
      source: 'observed',
    });
  }
  return found;
}

/**
 * Merges documented caps with anything observed live. An observed cap always
 * wins over the documented one for the same id — X telling us the real number
 * beats a figure copied out of the docs.
 */
export function mergeCaps(observed = []) {
  const byId = new Map(DOCUMENTED_CAPS.map((c) => [c.id, c]));
  for (const cap of observed) byId.set(cap.id, cap);
  return [...byId.values()];
}

/** Duty cycle and hours-per-day for one cap at a given poll interval. */
export function evaluateCap(cap, pollIntervalSeconds) {
  const drainSeconds = cap.limit * pollIntervalSeconds;
  const binds = drainSeconds < cap.windowSeconds;
  const dutyCycle = Math.min(1, drainSeconds / cap.windowSeconds);

  return {
    ...cap,
    // Requests we would make in one of this cap's windows if we never stopped.
    requestsPerWindow: cap.windowSeconds / pollIntervalSeconds,
    binds,
    dutyCycle,
    hoursPerDay: 24 * dutyCycle,
  };
}

/**
 * The headline figure: hours of polling available per day, and which cap (if
 * any) is responsible for limiting it.
 *
 * @param {number} pollIntervalSeconds
 * @param {Array} observedCaps caps read from live response headers
 */
export function pollingCapacity(pollIntervalSeconds, observedCaps = []) {
  const caps = mergeCaps(observedCaps).map((c) => evaluateCap(c, pollIntervalSeconds));

  const binding = caps.filter((c) => c.binds).sort((a, b) => a.dutyCycle - b.dutyCycle);
  const hoursPerDay = caps.length ? 24 * Math.min(...caps.map((c) => c.dutyCycle)) : 24;

  return {
    pollIntervalSeconds,
    caps,
    // null means nothing we know about limits the runtime — the honest answer
    // at any sane poll interval given the caps we can currently see.
    limitedBy: binding[0] ?? null,
    hoursPerDay,
    unlimited: !binding.length,
    // True once at least one cap came from a live response rather than the docs.
    anyObserved: caps.some((c) => c.source === 'observed'),
  };
}

// ---------------------------------------------------------------------------
// The active window
// ---------------------------------------------------------------------------

/**
 * Length of an active window in hours. Supports windows that cross midnight
 * (22:00 to 06:00 is eight hours, not minus sixteen).
 */
export function windowHours(startHHMM, endHHMM) {
  const start = timeToMinutes(startHHMM);
  const end = timeToMinutes(endHHMM);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // Equal start and end means the whole day, which is the only reading that
  // isn't a zero-length window nobody would deliberately configure.
  if (start === end) return 24;
  const span = end > start ? end - start : 1440 - start + end;
  return span / 60;
}

/** Is `nowMinutes` inside the window? Handles the midnight-crossing case. */
export function withinWindow(nowMinutes, startHHMM, endHHMM) {
  const start = timeToMinutes(startHHMM);
  const end = timeToMinutes(endHHMM);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  if (start === end) return true;
  return end > start
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/**
 * Everything the dashboard needs to render the capacity note, including whether
 * the chosen window is longer than the API can sustain.
 *
 * The shortfall is deliberately NOT an error. The user asked for the window to
 * be allowed either way and flagged instead — a bot that polls for eight of your
 * twelve requested hours is still far better than one that refuses to start.
 */
export function capacityNote(settings, pollIntervalSeconds, observedCaps = []) {
  const capacity = pollingCapacity(pollIntervalSeconds, observedCaps);

  const enabled = Boolean(settings.activeWindowEnabled);
  const requestedHours = enabled ? windowHours(settings.activeStart, settings.activeEnd) : 24;

  // Round before comparing: 23.999999 hours of capacity against a 24 hour
  // window is not a shortfall anyone wants a red warning about.
  const shortfall = round1(capacity.hoursPerDay) < round1(requestedHours);

  return {
    ...capacity,
    windowEnabled: enabled,
    requestedHours,
    shortfall,
    shortfallHours: shortfall ? requestedHours - capacity.hoursPerDay : 0,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
