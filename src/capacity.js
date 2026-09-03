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

/**
 * Fallback caps, used only until X reports its own on a live response.
 *
 * The documentation and the live API disagree here. X's rate-limit docs give
 * 3,500/15min per app for GET /2/users/:id/tweets, but the bearer token this
 * bot uses measured `x-rate-limit-limit: 10000` on a real response. The
 * measurement wins — it is this token, this endpoint, right now — which is why
 * an observed cap always overrides anything in this list.
 *
 * The conservative documented figure is kept as the fallback deliberately: if
 * it is wrong it can only understate capacity, and understating is the safe
 * direction for a fallback that applies before the first poll of a fresh
 * install. Neither figure binds in practice — 3-second polling is 300 requests
 * per 15 minutes.
 */
export const DOCUMENTED_CAPS = [
  {
    id: 'requests_15min',
    label: 'Requests per 15 minutes (per app)',
    limit: 3500,
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
 * Our own daily request budget, expressed as a cap so it goes through the same
 * arithmetic as X's.
 *
 * This exists because of the 2 Sep 2026 outage. Roughly 18,000 requests over
 * ~15 hours of 3-second polling ended in "usage cap exceeded", and X does not
 * document a per-day request cap for this endpoint — so the limit that actually
 * stopped the bot is one we cannot look up. A budget we enforce ourselves is
 * the only cap we can be certain about, and it fails safe: the bot stops
 * polling and says so, instead of being cut off by X and going blind.
 */
export function budgetCap(maxRequestsPerDay) {
  if (!Number.isFinite(maxRequestsPerDay) || maxRequestsPerDay <= 0) return null;
  return {
    id: 'own_daily_budget',
    // Says "self-imposed" on purpose: this is the only line in the capacity
    // table that is not one of X's limits, and it must never be mistaken for one.
    label: 'Daily request budget (self-imposed)',
    limit: maxRequestsPerDay,
    windowSeconds: 86400,
    source: 'your setting',
  };
}

/**
 * Merges documented caps with anything observed live. An observed cap always
 * wins over the documented one for the same id — X telling us the real number
 * beats a figure copied out of the docs.
 */
export function mergeCaps(observed = [], extra = []) {
  const byId = new Map(DOCUMENTED_CAPS.map((c) => [c.id, c]));
  for (const cap of observed) byId.set(cap.id, cap);
  for (const cap of extra) if (cap) byId.set(cap.id, cap);
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
export function pollingCapacity(pollIntervalSeconds, observedCaps = [], maxRequestsPerDay = null) {
  const caps = mergeCaps(observedCaps, [budgetCap(maxRequestsPerDay)]).map((c) =>
    evaluateCap(c, pollIntervalSeconds),
  );

  const binding = caps.filter((c) => c.binds).sort((a, b) => a.dutyCycle - b.dutyCycle);
  const hoursPerDay = caps.length ? 24 * Math.min(...caps.map((c) => c.dutyCycle)) : 24;

  return {
    pollIntervalSeconds,
    // Requests a full day of uninterrupted polling would make. This is the
    // number that mattered on 2 Sep and was displayed nowhere.
    requestsPerDay: 86400 / pollIntervalSeconds,
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
export function capacityNote(settings, pollIntervalSeconds, observedCaps = [], maxRequestsPerDay = null) {
  const capacity = pollingCapacity(pollIntervalSeconds, observedCaps, maxRequestsPerDay);

  const enabled = Boolean(settings.activeWindowEnabled);
  const requestedHours = enabled ? windowHours(settings.activeStart, settings.activeEnd) : 24;

  // Round before comparing: 23.999999 hours of capacity against a 24 hour
  // window is not a shortfall anyone wants a red warning about.
  const shortfall = round1(capacity.hoursPerDay) < round1(requestedHours);

  return {
    ...capacity,
    windowEnabled: enabled,
    requestedHours,
    // What the configured window will actually spend in a day — the honest
    // headline, independent of any cap we may or may not know about.
    requestsInWindow: Math.round((requestedHours * 3600) / pollIntervalSeconds),
    shortfall,
    shortfallHours: shortfall ? requestedHours - capacity.hoursPerDay : 0,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
