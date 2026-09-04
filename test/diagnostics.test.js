import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LATE_MINUTES,
  buildActivity,
  classifyAftermath,
  typicalLagSeconds,
  averageLagSeconds,
  averageIndexingSeconds,
  rejectOutliers,
  expectedReactionSeconds,
  indexingDelaySeconds,
  postIdToDate,
} from '../src/diagnostics.js';

const at = (iso) => new Date(iso);

/** A post read `lagMin` after publication. */
function post(publishedIso, lagMin) {
  const published = at(publishedIso);
  return { published, seen: new Date(published.getTime() + lagMin * 60000), lagMin };
}

// ---------------------------------------------------------------------------
// The rule that was wrong: silence alone proves nothing
// ---------------------------------------------------------------------------

test('a lone failure followed by a prompt read is a RECOVERY, not a stall', () => {
  // The real case that disproved the old rule: a Cloudflare 522 at 02:49 on
  // 2 Sep 2026 appeared exactly once, was followed by silence, and the bot kept
  // working for hours afterwards. The old tool called this a stopped loop.
  const failure = at('2026-09-02T02:49:16Z');
  const healthy = post('2026-09-02T02:59:00Z', 0.2);
  const activity = buildActivity([healthy], [{ at: failure }]);

  const result = classifyAftermath(failure, activity, []);
  assert.equal(result.verdict, 'recovered');
  assert.match(result.detail, /read on time/);
});

test('a failure followed by silence AND late posts is a stall', () => {
  const failure = at('2026-09-02T10:37:05Z');
  // Published during the silence, read 9.3h later when polling resumed.
  const late = post('2026-09-02T15:55:59Z', 559);
  const activity = buildActivity([late], [{ at: failure }]);

  const result = classifyAftermath(failure, activity, [late]);
  assert.equal(result.verdict, 'STALLED');
  assert.match(result.detail, /14\.6h/);
  assert.match(result.detail, /1 post\(s\)/);
});

test('a long quiet stretch with nothing published is explicitly unproven', () => {
  // An idle night is indistinguishable from a dead process, and saying so is
  // more useful than guessing either way.
  const failure = at('2026-09-02T03:00:16Z');
  const activity = buildActivity([], [{ at: failure }]);

  const result = classifyAftermath(failure, activity, [], at('2026-09-02T09:00:00Z'));
  assert.equal(result.verdict, 'unproven');
  assert.match(result.detail, /nothing was published/);
});

test('an outage later in the day does not incriminate an earlier recovered failure', () => {
  // The second bug found in testing: scanning every post published after the
  // error let the 15:55 backlog mark the 03:00 Cloudflare error as a stall,
  // even though a post had been read on time at 04:20.
  const early = at('2026-09-02T03:00:16Z');
  const later = at('2026-09-02T10:37:05Z');
  const healthy = post('2026-09-02T04:20:00Z', 0.2);
  const late = post('2026-09-02T15:55:59Z', 559);

  const activity = buildActivity([healthy, late], [{ at: early }, { at: later }]);

  assert.equal(classifyAftermath(early, activity, [late]).verdict, 'recovered');
  assert.equal(classifyAftermath(later, activity, [late]).verdict, 'STALLED');
});

test('a short gap counts as recovery even with no post to prove it', () => {
  const failure = at('2026-09-02T10:00:00Z');
  const next = at('2026-09-02T10:10:00Z');
  const activity = buildActivity([], [{ at: failure }, { at: next }]);

  const result = classifyAftermath(failure, activity, []);
  assert.equal(result.verdict, 'recovered');
  assert.match(result.detail, /10 min/);
});

test('a failure with nothing after it at all is judged against now', () => {
  const failure = at('2026-09-02T10:00:00Z');
  const activity = buildActivity([], [{ at: failure }]);

  const stillQuiet = classifyAftermath(failure, activity, [], at('2026-09-02T10:30:00Z'));
  assert.equal(stillQuiet.verdict, 'recovered', 'half an hour is not yet evidence of anything');

  const longQuiet = classifyAftermath(failure, activity, [], at('2026-09-03T10:00:00Z'));
  assert.equal(longQuiet.verdict, 'unproven');
});

// ---------------------------------------------------------------------------
// Activity classification
// ---------------------------------------------------------------------------

test('reads are tagged prompt or late, and errors kept separate', () => {
  const prompt = post('2026-09-02T04:20:00Z', 0.2);
  const late = post('2026-09-02T15:55:00Z', 559);
  const activity = buildActivity([prompt, late], [{ at: at('2026-09-02T10:37:00Z') }]);

  assert.deepEqual(
    activity.map((a) => a.kind),
    ['prompt-read', 'error', 'late-read'],
    'ordered by time, with each kind distinguished',
  );
});

test('a read exactly at the late threshold is not yet late', () => {
  const edge = post('2026-09-02T04:00:00Z', LATE_MINUTES);
  assert.equal(buildActivity([edge], [])[0].kind, 'prompt-read');
});

// ---------------------------------------------------------------------------
// Typical lag
// ---------------------------------------------------------------------------

test('the typical lag ignores the outage instead of averaging through it', () => {
  // Six healthy reads at ~12s and six 8-hour ones. A plain median lands between
  // the clusters and describes neither — it reported 26,153s in testing.
  const healthy = Array.from({ length: 6 }, (_, i) => post(`2026-09-0${i + 1}T04:00:00Z`, 0.2));
  const late = Array.from({ length: 6 }, (_, i) => post(`2026-09-0${i + 1}T15:00:00Z`, 480));

  const typical = typicalLagSeconds([...healthy, ...late]);
  assert.equal(typical, 12, 'the healthy cluster is what "typical" means');
});

test('typical lag is null when nothing was ever read promptly', () => {
  assert.equal(typicalLagSeconds([post('2026-09-02T15:00:00Z', 480)]), null);
  assert.equal(typicalLagSeconds([]), null);
});

test('indexing delay subtracts half the poll interval', () => {
  // At a 3s interval a post waits 1.5s on average for the next poll, so a 12s
  // observed lag means X itself took about 10.5s to make the post visible.
  assert.equal(indexingDelaySeconds(12, 3), 10.5);
  assert.equal(indexingDelaySeconds(12, 30), -3, 'a negative result means the interval dominates');
  assert.equal(indexingDelaySeconds(null, 3), null);
});

// ---------------------------------------------------------------------------
// Reaction time, projected for any interval
// ---------------------------------------------------------------------------




test('reaction time follows the interval without re-measuring', () => {
  // The whole point: an 11s floor projects to any interval, including ones
  // this bot has never actually run at.
  assert.equal(expectedReactionSeconds(11, 3), 12.5);
  assert.equal(expectedReactionSeconds(11, 30), 26);
  assert.equal(expectedReactionSeconds(11, 60), 41);
  assert.equal(expectedReactionSeconds(null, 30), null);
});

test('going ten times slower costs far less than ten times the delay', () => {
  // 3s -> 30s is 10x fewer requests for about 13 extra seconds, because X's
  // indexing delay dominates and is unaffected by either choice.
  const fast = expectedReactionSeconds(11, 3);
  const slow = expectedReactionSeconds(11, 30);
  assert.ok(slow - fast < 14, `expected under 14s of difference, got ${(slow - fast).toFixed(1)}s`);
  assert.ok(slow < fast * 3, 'nowhere near ten times worse');
});

// ---------------------------------------------------------------------------
// Post IDs carry their own publication time
// ---------------------------------------------------------------------------

test('a post ID decodes to the time it was published', () => {
  // The six real @NeedhamDriving posts from 2 Sep 2026, verified against the
  // created_at X returned for them.
  const known = [
    ['2095178936418238606', '2026-09-02T15:55:59.641Z'],
    ['2095179445917130840', '2026-09-02T15:58:01.115Z'],
    ['2095185262275858833', '2026-09-02T16:21:07.843Z'],
    ['2095189996432924725', '2026-09-02T16:39:56.554Z'],
    ['2095208922147704995', '2026-09-02T17:55:08.796Z'],
    ['2095209955867423016', '2026-09-02T17:59:15.254Z'],
  ];
  for (const [id, iso] of known) {
    assert.equal(postIdToDate(id).toISOString(), iso, `id ${id}`);
  }
});

test('post IDs must be shifted as BigInt, not with a JS bitwise operator', () => {
  // The trap: `>>` coerces its operand to a 32-bit int, so shifting a post ID
  // with it does not merely lose precision — it produces nonsense. These IDs
  // are also past Number.MAX_SAFE_INTEGER, hence BigInt throughout.
  const id = '2095178936418238606';
  assert.ok(Number(id) > Number.MAX_SAFE_INTEGER);

  const broken = new Date((Number(id) >> 22) + 1288834974657);
  assert.equal(broken.getUTCFullYear(), 2010, 'the 32-bit shift collapses to the epoch');
  assert.equal(postIdToDate(id).getUTCFullYear(), 2026);
});

test('consecutive IDs decode to distinct milliseconds', () => {
  // One millisecond apart is 2^22 in the ID. If precision were being lost this
  // would collapse to a single instant.
  const base = 2095178936418238606n;
  const a = postIdToDate(String(base));
  const b = postIdToDate(String(base + (1n << 22n)));
  assert.equal(b - a, 1, 'exactly one millisecond apart');
});

test('a malformed id yields null rather than a plausible wrong date', () => {
  for (const bad of ['', null, undefined, 'abc', '12.5', '-1', '0']) {
    assert.equal(postIdToDate(bad), null, `input ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// Average lag: recent, and not dragged around by one bad reading
// ---------------------------------------------------------------------------

/** A read `lagSeconds` after publication, seen at `order` (higher = newer). */
function read(lagSeconds, order = 0) {
  return { seen: new Date(2026, 8, 3, 12, 0, order), lagMin: lagSeconds / 60 };
}

test('a single slow read does not drag the average', () => {
  // The exact complaint: an 8-minute reading among 12-second ones was being
  // averaged in, because the old cutoff only excluded lags above 30 minutes.
  const reads = [read(11), read(12), read(12), read(13), read(14), read(12), read(13), read(480)];
  const avg = averageLagSeconds(reads);

  assert.equal(avg.excluded, 1, 'the 8-minute read is an outlier among 12-second ones');
  assert.equal(avg.used, 7);
  assert.ok(avg.averageSeconds > 11 && avg.averageSeconds < 13, `got ${avg.averageSeconds}`);
});

test('an outage-length lag is discarded too', () => {
  const reads = [read(11), read(12), read(12), read(13), read(14), read(26280)];
  const avg = averageLagSeconds(reads);
  assert.equal(avg.excluded, 1);
  assert.ok(avg.averageSeconds < 13);
});

test('the average is taken over the most recent posts only', () => {
  // 50 recent reads at ~12s, plus older ones at 40s that must fall outside the
  // window. A lifetime average would still be carrying the old behaviour.
  const recent = Array.from({ length: 50 }, (_, i) => read(12, 100 + i));
  const older = Array.from({ length: 30 }, (_, i) => read(40, i));

  const avg = averageLagSeconds([...older, ...recent], 50);
  assert.equal(avg.considered, 50);
  assert.equal(avg.averageSeconds, 12, 'the older, slower era is out of the window');
});

test('near-identical readings are not pruned to nothing', () => {
  // With an interquartile range of zero, a bare 1.5xIQR fence would reject
  // every value that is not exactly the median.
  const reads = [read(12), read(12), read(12), read(12), read(13)];
  const avg = averageLagSeconds(reads);
  assert.equal(avg.excluded, 0);
  assert.equal(avg.used, 5);
});

test('too few readings to judge means nothing is discarded', () => {
  const { kept, excluded } = rejectOutliers([12, 480, 13]);
  assert.equal(excluded.length, 0, 'three points cannot establish quartiles');
  assert.equal(kept.length, 3);
});

test('outlier rejection is symmetric', () => {
  const { excluded } = rejectOutliers([12, 12, 13, 12, 13, 12, 0.01, 480]);
  assert.ok(excluded.includes(480));
  assert.ok(excluded.includes(0.01), 'an impossibly fast read is as suspect as a slow one');
});

test('no posts means no average rather than a zero', () => {
  const avg = averageLagSeconds([]);
  assert.equal(avg.averageSeconds, null);
  assert.equal(avg.used, 0);
});

test('the average rounds to one decimal place cleanly', () => {
  const reads = [read(11), read(12), read(12), read(13)];
  const avg = averageLagSeconds(reads);
  assert.equal(avg.averageSeconds.toFixed(1), '12.0');
});

test('the indexing delay is corrected per post, not by the current interval', () => {
  // Posts read while polling every 3s: a 12s lag is ~10.5s of X plus ~1.5s of
  // waiting. Switching to 30s must not retroactively reinterpret them —
  // subtracting 15s from a 12s average went negative and was clamped to zero,
  // reporting "0.0s of it is X's own indexing delay".
  const reads = [11, 12, 12, 13, 14, 12].map((s, i) => ({
    seen: new Date(2026, 8, 3, 12, 0, i),
    lagMin: s / 60,
    pollIntervalSeconds: 3,
  }));

  const indexing = averageIndexingSeconds(reads, 50, 30);
  assert.ok(indexing > 9 && indexing < 12, `expected ~10.5s of X delay, got ${indexing}`);

  // And the projection to the new interval stays sensible.
  assert.ok(expectedReactionSeconds(indexing, 30) > 24);
});

test('posts recorded before the interval column fall back sensibly', () => {
  const reads = [12, 12, 13, 12].map((s, i) => ({
    seen: new Date(2026, 8, 3, 12, 0, i),
    lagMin: s / 60,
  }));
  assert.ok(Math.abs(averageIndexingSeconds(reads, 50, 3) - 10.75) < 0.3);
});

test('a mixed history uses each post\'s own interval', () => {
  const reads = [
    ...[12, 12, 13].map((s, i) => ({ seen: new Date(2026, 8, 3, 12, 0, i), lagMin: s / 60, pollIntervalSeconds: 3 })),
    ...[26, 25, 27].map((s, i) => ({ seen: new Date(2026, 8, 3, 12, 1, i), lagMin: s / 60, pollIntervalSeconds: 30 })),
  ];
  // Both eras imply roughly the same ~11s of X delay despite very different lags.
  const indexing = averageIndexingSeconds(reads, 50, 3);
  assert.ok(indexing > 9.5 && indexing < 12, `got ${indexing}`);
});
