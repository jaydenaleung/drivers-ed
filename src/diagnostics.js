/**
 * Reasoning about outages, separated from the script that prints them.
 *
 * This lives in its own module because the judgement it makes is easy to get
 * wrong and expensive to get wrong quietly. An earlier version of the diagnose
 * tool asserted a rule instead of checking evidence — "a failure that appears
 * once and is then followed by silence did not retry" — and the rule was simply
 * false. A Cloudflare 522 on 2 Sep 2026 appeared exactly once, was followed by
 * silence, and the bot had plainly recovered: it kept working for hours.
 *
 * The correct test is a conjunction, and the reason is worth stating plainly:
 * a successful poll that finds nothing logs nothing. Silence is therefore the
 * NORMAL appearance of a healthy bot on a quiet night, and is indistinguishable
 * on its own from a dead process. What separates the two is whether anything
 * was published during the silence and only read at the end of it.
 */

/** Minutes after publication beyond which a post counts as read late. */
export const LATE_MINUTES = 30;

const hoursBetween = (a, b) => (b - a) / 3600000;

/**
 * Builds the ordered record of everything the bot is known to have done.
 *
 * A post read PROMPTLY proves the loop was alive and polling at that moment.
 * An error proves only that it was alive enough to fail. A post read LATE
 * proves nothing about the moment it was read except that polling had resumed
 * by then. Keeping the kinds distinct is what makes the verdicts below sound.
 *
 * @param {Array<{seen: Date, lagMin: number}>} lagged
 * @param {Array<{at: Date}>} errors
 */
export function buildActivity(lagged, errors) {
  return [
    ...lagged.map((l) => ({
      at: l.seen,
      kind: l.lagMin <= LATE_MINUTES ? 'prompt-read' : 'late-read',
    })),
    ...errors.map((e) => ({ at: e.at, kind: 'error' })),
  ].sort((a, b) => a.at - b.at);
}

/**
 * Judges what happened after a moment in time.
 *
 * @param {Date} at the moment in question — usually a poll failure
 * @param {Array<{at: Date, kind: string}>} activity from buildActivity()
 * @param {Array<{published: Date, seen: Date, lagMin: number}>} latePosts
 * @param {Date} [now]
 * @returns {{verdict: 'STALLED'|'recovered'|'unproven', detail: string, gapHours: number}}
 */
export function classifyAftermath(at, activity, latePosts, now = new Date()) {
  const next = activity.find((a) => a.at > at);
  const silenceEnds = next ? next.at : now;
  const gapHours = hoursBetween(at, silenceEnds);

  // Only posts published INSIDE the silence count. An earlier version scanned
  // every post published after the error, which let an unrelated outage seven
  // hours downstream incriminate a failure the bot had already recovered from.
  const overdue = latePosts.filter((l) => l.published > at && l.published <= silenceEnds);

  if (overdue.length) {
    const worstHours = Math.max(...overdue.map((l) => l.lagMin)) / 60;
    return {
      verdict: 'STALLED',
      gapHours,
      detail:
        `nothing recorded for ${gapHours.toFixed(1)}h, and ${overdue.length} post(s) published ` +
        `during it were read up to ${worstHours.toFixed(1)}h late`,
    };
  }

  // A post read on time is positive proof the loop was polling by then.
  if (next?.kind === 'prompt-read') {
    const when = gapHours < 1 ? `${(gapHours * 60).toFixed(0)} min` : `${gapHours.toFixed(1)}h`;
    return { verdict: 'recovered', gapHours, detail: `a post was read on time ${when} later` };
  }

  if (gapHours <= 1) {
    return {
      verdict: 'recovered',
      gapHours,
      detail: `activity resumed after ${(gapHours * 60).toFixed(0)} min`,
    };
  }

  return {
    verdict: 'unproven',
    gapHours,
    detail:
      `quiet for ${gapHours.toFixed(1)}h, but nothing was published in that time — ` +
      `a working bot and a stopped one look the same here`,
  };
}

/**
 * Typical lag across HEALTHY reads only, in seconds.
 *
 * Including an outage in a "typical lag" figure is how you report a median of
 * seven hours: with enough late posts the median falls between the two clusters
 * and describes neither of them.
 */
export function typicalLagSeconds(lagged) {
  const healthy = lagged
    .filter((l) => l.lagMin <= LATE_MINUTES)
    .sort((a, b) => a.lagMin - b.lagMin);
  if (healthy.length === 0) return null;
  return healthy[Math.floor(healthy.length / 2)].lagMin * 60;
}

/**
 * How much of the observed lag is X's own indexing delay rather than our poll
 * interval. On average a post waits half an interval before the next poll, so
 * whatever remains is X. This is the floor no polling rate can get below.
 */
export function indexingDelaySeconds(typicalSeconds, pollIntervalSeconds) {
  if (typicalSeconds === null) return null;
  return typicalSeconds - pollIntervalSeconds / 2;
}
