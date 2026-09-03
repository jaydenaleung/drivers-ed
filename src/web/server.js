import crypto from 'node:crypto';
import express from 'express';
import { config, KNOWN_AREAS } from '../config.js';
import { getSettings, updateSettings } from '../settings.js';
import { recentErrors, clearErrors } from '../errors.js';
import { getState, STATE_KEYS } from '../db.js';
import { hydrate } from '../pipeline.js';
import { sendTestNotification } from '../notify.js';
import { capacityNote, withinWindow } from '../capacity.js';
import { observedRateCaps, requestsToday } from '../x/client.js';
import { nowMinutesInTz } from '../parser/normalize.js';
import { loginPage, dashboardPage } from './views.js';

const COOKIE_NAME = 'de_session';
const SESSION_HOURS = 24 * 14;

// --- session cookie ---------------------------------------------------------

function sign(value) {
  return crypto.createHmac('sha256', config.dashboard.sessionSecret).update(value).digest('hex');
}

function issueToken() {
  const issuedAt = Date.now().toString();
  return `${issuedAt}.${sign(issuedAt)}`;
}

function tokenIsValid(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [issuedAt, signature] = token.split('.');
  const expected = sign(issuedAt);

  // Constant-time compare so the signature can't be probed byte by byte.
  const a = Buffer.from(signature ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < SESSION_HOURS * 3600 * 1000;
}

/** Constant-time password check — never a plain `===` on a secret. */
function passwordMatches(supplied) {
  const a = crypto.createHash('sha256').update(String(supplied ?? '')).digest();
  const b = crypto.createHash('sha256').update(config.dashboard.password).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Strict also serves as CSRF protection: a form on another site cannot
    // cause the browser to attach this cookie to a POST here.
    'SameSite=Strict',
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  // Caddy terminates TLS in front of us, so the browser always speaks HTTPS.
  if (!config.dryRun || config.host !== '127.0.0.1') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

// --- app --------------------------------------------------------------------

export function createServer(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.get('/healthz', (req, res) => {
    const lastPollAt = getState(db, STATE_KEYS.LAST_POLL_OK_AT);
    res.json({ ok: true, lastPollAt, dryRun: config.dryRun, postSource: config.postSource });
  });

  app.get('/login', (req, res) => {
    if (tokenIsValid(readCookie(req, COOKIE_NAME))) return res.redirect('/');
    res.type('html').send(loginPage({}));
  });

  app.post('/login', (req, res) => {
    if (!passwordMatches(req.body?.password)) {
      return res.status(401).type('html').send(loginPage({ error: 'Wrong password.' }));
    }
    setSessionCookie(res, issueToken());
    res.redirect('/');
  });

  app.post('/logout', (req, res) => sendToLogin(res));
  app.get('/logout', (req, res) => sendToLogin(res));

  function sendToLogin(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.redirect('/login');
  }

  // Everything below this line requires the password (§8).
  app.use((req, res, next) => {
    if (tokenIsValid(readCookie(req, COOKIE_NAME))) return next();
    res.redirect('/login');
  });

  app.get('/', (req, res) => {
    res.type('html').send(renderDashboard(db, {}));
  });

  app.post('/settings', (req, res) => {
    const body = req.body ?? {};
    const submittedAreas = [].concat(body.areas ?? []);

    try {
      updateSettings(db, {
        scriptEnabled: body.script_enabled === '1',
        areas: submittedAreas.filter((a) => KNOWN_AREAS.includes(a)),
        timeRangeStart: body.time_range_start,
        timeRangeEnd: body.time_range_end,
        dateRangeStart: body.date_range_start || null,
        dateRangeEnd: body.date_range_end || null,
        overrunBufferMinutes: Number.parseInt(body.overrun_buffer_minutes, 10),
        activeWindowEnabled: body.active_window_enabled === '1',
        activeStart: body.active_start,
        activeEnd: body.active_end,
      });
      res.type('html').send(renderDashboard(db, { saved: true }));
    } catch (err) {
      res.status(400).type('html').send(renderDashboard(db, { error: err.message }));
    }
  });

  app.post('/errors/clear', (req, res) => {
    clearErrors(db);
    res.redirect('/');
  });

  // Deleting the lesson row is what actually lets a later identical post be
  // treated as new: dedupe is a UNIQUE index on date+start_time+areas, so while
  // the row exists the same lesson can never be re-created. Removing test data
  // therefore has to remove the rows, not just hide them.
  app.post('/lessons/clear-skipped', (req, res) => {
    db.prepare(
      `DELETE FROM lessons
        WHERE status IN ('skipped_no_match', 'skipped_already_claimed', 'claimed_by_school', 'error')`,
    ).run();
    res.redirect('/');
  });

  app.post('/lessons/clear-claimed', (req, res) => {
    // Only the sent records. An in-flight 'sending' row is deliberately left
    // alone — deleting it mid-send would drop the guard that stops a second
    // email going out for the same lesson.
    db.prepare("DELETE FROM lessons WHERE status = 'email_sent'").run();
    res.redirect('/');
  });

  app.post('/test-notification', async (req, res) => {
    const result = await sendTestNotification();
    res.type('html').send(
      renderDashboard(db, {
        notify: {
          ok: result.ok,
          message: result.ok
            ? 'Test notification sent — check your phone.'
            : `Test notification failed: ${result.error}`,
        },
      }),
    );
  });

  return app;
}

function renderDashboard(db, flash) {
  const settings = getSettings(db);

  const claimed = db
    .prepare(`SELECT * FROM lessons WHERE status = 'email_sent' ORDER BY email_sent_at DESC LIMIT 100`)
    .all()
    .map(hydrate);

  const skipped = db
    .prepare(
      `SELECT * FROM lessons
        WHERE status IN ('skipped_no_match', 'skipped_already_claimed', 'claimed_by_school', 'error')
        ORDER BY lesson_date DESC, start_time DESC LIMIT 100`,
    )
    .all()
    .map(hydrate);

  const windowOpen =
    !settings.activeWindowEnabled ||
    withinWindow(nowMinutesInTz(config.timezone), settings.activeStart, settings.activeEnd);

  return dashboardPage({
    settings,
    claimed,
    skipped,
    errors: recentErrors(db, 50),
    flash,
    // Uses the caps X reported on the last poll where it reported any, so the
    // hours figure is measured rather than assumed once the bot has run.
    capacity: {
      ...capacityNote(
        settings,
        config.pollIntervalSeconds,
        observedRateCaps(db),
        config.maxRequestsPerDay,
      ),
      requestsToday: requestsToday(db),
      maxRequestsPerDay: config.maxRequestsPerDay,
    },
    health: {
      // .env is read once at startup, so "did my edit take effect?" is only
      // answerable if the page says when this process started and which file
      // it read. Editing .env and not restarting is the single most common
      // way to be confused by this dashboard.
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      configFiles: config.loadedEnvFiles,
      lastPollAt: getState(db, STATE_KEYS.LAST_POLL_OK_AT),
      lastPollError: getState(db, STATE_KEYS.LAST_POLL_ERROR),
      pollIntervalSeconds: config.pollIntervalSeconds,
      dryRun: config.dryRun,
      replayMode: config.postSource === 'replay',
      timezone: config.timezone,
      windowOpen,
      activeStart: settings.activeStart,
      activeEnd: settings.activeEnd,
    },
  });
}
