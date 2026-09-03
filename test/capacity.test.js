import test from 'node:test';
import assert from 'node:assert/strict';

import {
  capsFromHeaders,
  mergeCaps,
  evaluateCap,
  pollingCapacity,
  windowHours,
  withinWindow,
  capacityNote,
  DOCUMENTED_CAPS,
} from '../src/capacity.js';
import { nowMinutesInTz } from '../src/parser/normalize.js';

/** Minimal stand-in for a fetch Response's headers. */
function headers(map) {
  return { get: (name) => (name in map ? String(map[name]) : null) };
}

// ---------------------------------------------------------------------------
// The cap arithmetic
// ---------------------------------------------------------------------------

test('a cap that refills faster than we drain it never binds', () => {
  // 10,000 requests per 15 minutes vs one request every 3 seconds.
  const cap = evaluateCap(DOCUMENTED_CAPS[0], 3);
  assert.equal(cap.binds, false);
  assert.equal(cap.dutyCycle, 1);
  assert.equal(cap.hoursPerDay, 24);
  assert.equal(cap.requestsPerWindow, 300);
});

test('a cap smaller than the window drains early and yields partial hours', () => {
  // 10,000 requests per 24 hours at one every 3 seconds: the bucket lasts
  // 30,000 seconds = 8h20m, then stalls until the window resets.
  const cap = evaluateCap(
    { id: 'day', label: 'Per day', limit: 10000, windowSeconds: 86400, source: 'observed' },
    3,
  );
  assert.equal(cap.binds, true);
  assert.equal(Math.round(cap.hoursPerDay * 100) / 100, 8.33);
});

test('slowing the poll interval raises the sustainable hours proportionally', () => {
  const cap = { id: 'day', label: 'Per day', limit: 10000, windowSeconds: 86400, source: 'observed' };
  assert.equal(evaluateCap(cap, 3).hoursPerDay * 2, evaluateCap(cap, 6).hoursPerDay);
  // At 9 seconds the bucket covers the whole day and the cap stops binding.
  assert.equal(evaluateCap(cap, 9).binds, false);
});

test('the headline figure is set by the tightest cap, not the first one', () => {
  const observed = [
    { id: 'app_24hour', label: 'App per 24h', limit: 20000, windowSeconds: 86400, source: 'observed' },
    { id: 'user_24hour', label: 'User per 24h', limit: 5000, windowSeconds: 86400, source: 'observed' },
  ];
  const capacity = pollingCapacity(3, observed);

  assert.equal(capacity.unlimited, false);
  assert.equal(capacity.limitedBy.id, 'user_24hour', 'the smaller bucket is what actually stops us');
  assert.equal(Math.round(capacity.hoursPerDay * 100) / 100, 4.17);
});

test('with only the documented 15-minute cap, nothing binds at any sane interval', () => {
  for (const interval of [1, 3, 5, 10, 60]) {
    const capacity = pollingCapacity(interval);
    assert.equal(capacity.unlimited, true, `${interval}s should be unlimited`);
    assert.equal(capacity.hoursPerDay, 24);
    assert.equal(capacity.limitedBy, null);
  }
});

// ---------------------------------------------------------------------------
// Reading caps off a live response
// ---------------------------------------------------------------------------

test('rate cap headers are read off a response when present', () => {
  const caps = capsFromHeaders(
    headers({
      'x-rate-limit-limit': '900',
      'x-rate-limit-remaining': '898',
      'x-app-limit-24hour-limit': '10000',
      'x-app-limit-24hour-remaining': '9994',
    }),
  );

  assert.equal(caps.length, 2);
  const fifteen = caps.find((c) => c.id === 'requests_15min');
  assert.equal(fifteen.limit, 900);
  assert.equal(fifteen.remaining, 898);
  assert.equal(fifteen.source, 'observed');
});

test('a response with no cap headers yields no caps rather than invented ones', () => {
  assert.deepEqual(capsFromHeaders(headers({})), []);
  assert.deepEqual(capsFromHeaders(null), []);
});

test('an observed cap overrides the documented figure for the same limit', () => {
  // This is the whole point of reading headers: X saying 900 must beat the
  // 10,000 in the docs, or the dashboard reports capacity the token lacks.
  const merged = mergeCaps([
    { id: 'requests_15min', label: 'Requests per 15 minutes', limit: 900, windowSeconds: 900, source: 'observed' },
  ]);

  assert.equal(merged.length, 1, 'the documented cap must be replaced, not duplicated');
  assert.equal(merged[0].limit, 900);

  // And it changes the answer: 900 requests per 15 min at 1s does bind.
  const capacity = pollingCapacity(1, merged);
  assert.equal(capacity.unlimited, true, '900 requests x 1s = 900s, exactly one window');
  assert.equal(pollingCapacity(0.5, merged).unlimited, false, 'twice as fast no longer fits');
});

// ---------------------------------------------------------------------------
// The window itself
// ---------------------------------------------------------------------------

test('window length is computed in hours, including across midnight', () => {
  assert.equal(windowHours('07:00', '21:00'), 14);
  assert.equal(windowHours('22:00', '06:00'), 8, 'crossing midnight is eight hours, not minus sixteen');
  assert.equal(windowHours('09:30', '10:00'), 0.5);
  assert.equal(windowHours('00:00', '00:00'), 24);
});

test('withinWindow handles both ordinary and midnight-crossing windows', () => {
  assert.equal(withinWindow(8 * 60, '07:00', '21:00'), true);
  assert.equal(withinWindow(6 * 60, '07:00', '21:00'), false);
  assert.equal(withinWindow(21 * 60, '07:00', '21:00'), false, 'the end is exclusive');

  assert.equal(withinWindow(23 * 60, '22:00', '06:00'), true);
  assert.equal(withinWindow(2 * 60, '22:00', '06:00'), true);
  assert.equal(withinWindow(12 * 60, '22:00', '06:00'), false);
});

// ---------------------------------------------------------------------------
// The dashboard note
// ---------------------------------------------------------------------------

const baseSettings = {
  activeWindowEnabled: true,
  activeStart: '07:00',
  activeEnd: '21:00',
};

test('a window the API can sustain raises no warning', () => {
  const note = capacityNote(baseSettings, 10);
  assert.equal(note.requestedHours, 14);
  assert.equal(note.hoursPerDay, 24);
  assert.equal(note.shortfall, false);
});

test('a window LONGER than the API can sustain is allowed but flagged', () => {
  // The user asked for this explicitly: allow it, warn about it, never block it.
  const observed = [
    { id: 'app_24hour', label: 'App per 24h', limit: 10000, windowSeconds: 86400, source: 'observed' },
  ];
  const note = capacityNote(baseSettings, 3, observed);

  assert.equal(note.requestedHours, 14);
  assert.equal(Math.round(note.hoursPerDay * 100) / 100, 8.33);
  assert.equal(note.shortfall, true, 'a 14h window against 8.33h of capacity is a shortfall');
  assert.ok(note.shortfallHours > 5.6 && note.shortfallHours < 5.7);
  assert.equal(note.limitedBy.id, 'app_24hour');
});

test('with no window set the comparison is against a full 24 hours', () => {
  const observed = [
    { id: 'app_24hour', label: 'App per 24h', limit: 10000, windowSeconds: 86400, source: 'observed' },
  ];
  const note = capacityNote({ ...baseSettings, activeWindowEnabled: false }, 3, observed);

  assert.equal(note.requestedHours, 24);
  assert.equal(note.windowEnabled, false);
  assert.equal(note.shortfall, true, 'round-the-clock against 8.33h of capacity is still short');
});

test('floating-point dust does not manufacture a warning', () => {
  // 24 hours of capacity against a 24 hour request must not trip the flag on a
  // 23.999999 vs 24 comparison.
  const note = capacityNote({ ...baseSettings, activeWindowEnabled: false }, 10);
  assert.equal(note.shortfall, false);
});

// ---------------------------------------------------------------------------
// Timezone handling — the window is local time, the server clock is UTC
// ---------------------------------------------------------------------------

test('active hours are evaluated in the configured timezone, not the server clock', () => {
  // 2026-09-02T02:00:00Z is 22:00 on Sep 1 in New York. A 07:00-21:00 window
  // must be CLOSED, even though the server's own hour (02) also falls outside.
  // The revealing case is the one below it.
  const at02Z = new Date('2026-09-02T02:00:00Z');
  assert.equal(nowMinutesInTz('America/New_York', at02Z), 22 * 60);
  assert.equal(withinWindow(nowMinutesInTz('America/New_York', at02Z), '07:00', '21:00'), false);

  // 2026-09-02T10:00:00Z is 06:00 in New York. Using the server clock would
  // call this "10am, inside the window" and poll four hours early.
  const at10Z = new Date('2026-09-02T10:00:00Z');
  assert.equal(nowMinutesInTz('America/New_York', at10Z), 6 * 60);
  assert.equal(
    withinWindow(nowMinutesInTz('America/New_York', at10Z), '07:00', '21:00'),
    false,
    'the window must follow New York time, not UTC',
  );
  assert.equal(withinWindow(nowMinutesInTz('UTC', at10Z), '07:00', '21:00'), true);
});
