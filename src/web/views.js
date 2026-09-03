import { KNOWN_AREAS } from '../config.js';
import { SKIP_REASON_LABELS } from '../db.js';
import { windowHours } from '../capacity.js';

/** Escapes anything that reaches the page — post text is untrusted input. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
:root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1b1f24; --muted:#5b6570;
        --line:#dfe3e8; --ok:#0a7d33; --warn:#8a5a00; --bad:#b3261e; --accent:#1a56db; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#14171a; --card:#1d2125; --fg:#e6e9ec; --muted:#9aa4ae; --line:#2c3237;
          --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; --accent:#6294f5; }
}
* { box-sizing: border-box; }
body { margin:0; padding:1rem; background:var(--bg); color:var(--fg);
       font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
.wrap { max-width: 62rem; margin: 0 auto; }
h1 { font-size:1.4rem; margin:0 0 .25rem; }
h2 { font-size:1.05rem; margin:0 0 .75rem; }
.sub { color:var(--muted); margin:0 0 1.25rem; font-size:.9rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px;
        padding:1rem 1.15rem; margin-bottom:1rem; }
.banner { border-radius:10px; padding:.7rem 1rem; margin-bottom:1rem; font-weight:600; border:1px solid; }
.banner.ok   { color:var(--ok);   border-color:var(--ok);   background:color-mix(in srgb, var(--ok) 8%, transparent); }
.banner.warn { color:var(--warn); border-color:var(--warn); background:color-mix(in srgb, var(--warn) 10%, transparent); }
.banner.bad  { color:var(--bad);  border-color:var(--bad);  background:color-mix(in srgb, var(--bad) 10%, transparent); }
label { display:block; font-weight:600; margin:.9rem 0 .3rem; font-size:.9rem; }
input[type=time], input[type=date], input[type=number], input[type=password] {
  padding:.45rem .55rem; border:1px solid var(--line); border-radius:6px;
  background:var(--bg); color:var(--fg); font:inherit; }
.row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; }
.areas { display:flex; flex-wrap:wrap; gap:.5rem .9rem; margin-top:.3rem; }
.areas label { font-weight:400; margin:0; display:flex; align-items:center; gap:.35rem; }
button { font:inherit; font-weight:600; padding:.5rem .9rem; border-radius:6px;
         border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; }
button.secondary { background:transparent; color:var(--fg); border-color:var(--line); }
.toggle { display:flex; align-items:center; gap:.6rem; font-weight:700; font-size:1rem; }
table { width:100%; border-collapse:collapse; font-size:.9rem; }
th,td { text-align:left; padding:.45rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
.scroll { overflow-x:auto; }
/* Lists grow without limit as the bot runs, so cap their height and let
   them scroll rather than pushing the rest of the page out of reach. */
.scroll-y { max-height:20rem; overflow-y:auto; overflow-x:auto; }
.scroll-y thead th { position:sticky; top:0; background:var(--card); }
.rowactions { display:flex; gap:.6rem; flex-wrap:wrap; align-items:center; margin-top:.9rem; }
/* The capacity note sits inside the settings card, so it needs to read as a
   note rather than as another banner competing with the ones above it. */
.note { border:1px solid var(--line); border-left:3px solid var(--accent); border-radius:6px;
        padding:.6rem .8rem; margin:.2rem 0 1rem; font-size:.88rem; background:var(--bg); }
.note.alert { border-left-color:var(--bad); }
.note h3 { margin:0 0 .35rem; font-size:.88rem; }
.note ul { margin:.4rem 0 0; padding-left:1.1rem; }
.note li { margin:.15rem 0; }
.bang { color:var(--bad); font-weight:800; font-size:1.05em; }
.indent { margin-left:1.7rem; }
.empty { color:var(--muted); font-style:italic; }
.pill { display:inline-block; padding:.1rem .45rem; border-radius:999px; font-size:.78rem;
        border:1px solid var(--line); white-space:nowrap; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em; }
details summary { cursor:pointer; color:var(--muted); }
pre { white-space:pre-wrap; word-break:break-word; font-size:.8rem; color:var(--muted); margin:.4rem 0 0; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${STYLES}</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

export function loginPage({ error } = {}) {
  return page(
    'Sign in — drivers-ed',
    `<div class="card" style="max-width:24rem;margin:12vh auto">
      <h1>drivers-ed</h1>
      <p class="sub">Enter the dashboard password.</p>
      ${error ? `<div class="banner bad">${esc(error)}</div>` : ''}
      <form method="post" action="/login">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password"
               autofocus required style="width:100%">
        <p style="margin:1rem 0 0"><button type="submit">Sign in</button></p>
      </form>
    </div>`,
  );
}

/** Human-friendly "3 minutes ago" for the last-poll indicator. */
function ago(isoString) {
  if (!isoString) return null;
  const then = new Date(isoString);
  if (Number.isNaN(then.getTime())) return null;
  const secs = Math.floor((Date.now() - then.getTime()) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * The bot ships switched OFF so it cannot email anyone before criteria are set.
 * That is correct, but a lesson missed because the toggle was off is exactly
 * the failure this whole project exists to prevent — so say it loudly rather
 * than leaving it as a reason buried in a table column.
 */
function offBanner(settings, skipped) {
  if (settings.scriptEnabled) return '';

  const missed = (skipped ?? []).filter((l) => l.skip_reason === 'script_off').length;
  const detail = missed
    ? ` <strong>${missed}</strong> lesson${missed === 1 ? '' : 's'} below ${
        missed === 1 ? 'was' : 'were'
      } seen and deliberately not claimed for this reason.`
    : '';

  return `<div class="banner bad">THE BOT IS OFF — it is watching and recording, but it will not
    claim anything.${detail} Tick <em>Enable bot</em> in Settings below and press Save to arm it.</div>`;
}

function healthBanner({
  lastPollAt,
  lastPollError,
  pollIntervalSeconds,
  dryRun,
  replayMode,
  windowOpen,
  activeStart,
  activeEnd,
}) {
  const parts = [];

  if (dryRun) {
    parts.push(
      `<div class="banner warn">DRY RUN — the bot will do everything except actually send the email or the phone push. Set <code>DRY_RUN=false</code> in .env when you are ready to go live.</div>`,
    );
  }

  if (replayMode) {
    parts.push(
      `<div class="banner warn">REPLAY MODE — reading <code>fixtures/replay-posts.json</code>, not the live X account.</div>`,
    );
  }

  if (lastPollError) {
    // Credit exhaustion is the failure that silently blinds the bot, so it
    // gets the loudest possible treatment rather than sitting in the error feed.
    const isCredits = /credit/i.test(lastPollError);
    const isCap = /read cap/i.test(lastPollError);
    parts.push(
      `<div class="banner bad">${
        isCredits
          ? 'X API CREDITS EXHAUSTED — the bot cannot see new posts until you top up. '
          : isCap
            ? 'DAILY SPEND CAP HIT — polling paused until UTC midnight to stop runaway cost. '
            : 'Last poll failed: '
      }${esc(lastPollError)}</div>`,
    );
  }

  const staleAfter = Math.max(pollIntervalSeconds * 6, 120) * 1000;
  const stale = !lastPollAt || Date.now() - new Date(lastPollAt).getTime() > staleAfter;

  // A closed active window makes the last poll go stale on purpose. Reporting
  // that as "the loop may have stopped" would train you to ignore the one
  // banner that is supposed to mean something is actually wrong.
  if (windowOpen === false) {
    parts.push(
      `<div class="banner warn">OUTSIDE ACTIVE HOURS — the bot is deliberately not polling X until
        ${esc(activeStart)}. It will resume on its own; nothing is broken.${
          lastPollAt ? ` Last poll ${esc(ago(lastPollAt))}.` : ''
        }</div>`,
    );
    return parts.join('\n');
  }

  if (!lastPollAt) {
    parts.push(`<div class="banner warn">No successful poll yet.</div>`);
  } else if (stale) {
    parts.push(
      `<div class="banner bad">Last successful poll was ${esc(ago(lastPollAt))} — the loop may have stopped.</div>`,
    );
  } else {
    parts.push(
      `<div class="banner ok">Polling normally — last successful poll ${esc(ago(lastPollAt))}.</div>`,
    );
  }

  return parts.join('\n');
}

function hrs(n) {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)} h`;
}

/**
 * The note above the active-hours controls: how many hours a day the X API can
 * actually sustain at the current poll interval, and whether that is less than
 * the window the user has asked for.
 *
 * Two things this deliberately does NOT do:
 *  - invent a 24-hour request cap. If X has one for this endpoint it arrives in
 *    a response header and appears here automatically; until one is seen, the
 *    note says which figures are measured and which come from the docs.
 *  - fold the spend caps into the hours figure. X bills per post returned, not
 *    per request, so those caps bound money and not time. Mixing them in would
 *    produce a confident-looking number that answers a different question.
 */
function capacityNoteHtml(cap, timezone) {
  if (!cap) return '';

  const short = cap.shortfall;
  const bang = `<span class="bang" title="Your window is longer than the API can sustain">!</span>`;

  const headline = cap.unlimited
    ? `At <strong>${esc(cap.pollIntervalSeconds)}s</strong> between polls, no X rate cap ever binds —
       the bot can poll <strong>continuously, ${hrs(24)}/day</strong>.`
    : `At <strong>${esc(cap.pollIntervalSeconds)}s</strong> between polls, X's rate caps allow about
       <strong>${hrs(cap.hoursPerDay)}/day</strong> of polling
       (limited by ${esc(cap.limitedBy.label.toLowerCase())}).`;

  const comparison = cap.windowEnabled
    ? short
      ? `<p class="indent" style="margin:.5rem 0 0;color:var(--bad);font-weight:600">
           ${bang} You have asked for <strong>${hrs(cap.requestedHours)}/day</strong>, which is
           ${hrs(cap.shortfallHours)} more than the API can sustain. This is allowed — the bot will
           simply stop polling partway through the window and resume when the cap resets. Raise the
           poll interval or shorten the window to close the gap.
         </p>`
      : `<p class="indent" style="margin:.5rem 0 0;color:var(--muted)">
           Your window asks for ${hrs(cap.requestedHours)}/day, which fits comfortably.
         </p>`
    : `<p class="indent" style="margin:.5rem 0 0;color:var(--muted)">
         No window set — the bot polls around the clock.
       </p>`;

  const capRows = cap.caps
    .map((c) => {
      const per = c.requestsPerWindow;
      const window = c.windowSeconds >= 3600 ? `${c.windowSeconds / 3600} h` : `${c.windowSeconds / 60} min`;
      const verdict = c.binds
        ? `<strong style="color:var(--bad)">binds — allows ${hrs(c.hoursPerDay)}/day</strong>`
        : `does not bind`;
      return `<li>${esc(c.label)}: <strong>${esc(c.limit.toLocaleString('en-US'))}</strong> per ${esc(window)};
        we would use <strong>${esc(Math.round(per).toLocaleString('en-US'))}</strong> — ${verdict}
        <span class="pill">${c.source === 'observed' ? 'measured from X' : 'from the docs'}</span></li>`;
    })
    .join('');

  const unobserved = cap.anyObserved
    ? ''
    : `<li style="color:var(--muted)">No cap headers seen from X yet. These figures come from the
         documentation; they are replaced with X's own numbers after the first successful poll,
         including any 24-hour cap this endpoint turns out to have.</li>`;

  return `<div class="note ${short ? 'alert' : ''}">
    <h3>Polling capacity ${short ? bang : ''}</h3>
    <p style="margin:0">${headline}</p>
    ${comparison}
    <ul>
      ${capRows}
      ${unobserved}
      <li style="color:var(--muted)">Not counted above, because they cap money rather than hours:
        X bills per post <em>returned</em>, so polls that find nothing are free and cost nothing
        no matter how often they run. Your daily read cap and prepaid credit balance are unaffected
        by the poll interval.</li>
    </ul>
    <p style="margin:.5rem 0 0;color:var(--muted)">Active hours are ${esc(timezone)} local time.</p>
  </div>`;
}

function settingsForm(settings, { saved, error }, capacity, timezone) {
  const checkbox = (area) => `
    <label><input type="checkbox" name="areas" value="${esc(area)}"
      ${settings.areas.includes(area) ? 'checked' : ''}> ${esc(area)}</label>`;

  return `<div class="card">
    <h2>Settings</h2>
    ${saved ? `<div class="banner ok">Saved.</div>` : ''}
    ${error ? `<div class="banner bad">${esc(error)}</div>` : ''}
    <form method="post" action="/settings">
      <p class="toggle">
        <input type="checkbox" id="script_enabled" name="script_enabled" value="1"
               ${settings.scriptEnabled ? 'checked' : ''}>
        <label for="script_enabled" style="margin:0">Enable bot</label>
        <span class="pill" style="font-weight:600;color:${
          settings.scriptEnabled ? 'var(--ok)' : 'var(--bad)'
        };border-color:currentColor">currently ${settings.scriptEnabled ? 'ON' : 'OFF'}</span>
      </p>

      ${capacityNoteHtml(capacity, timezone)}

      <p class="toggle" style="font-size:.95rem">
        <input type="checkbox" id="active_window_enabled" name="active_window_enabled" value="1"
               ${settings.activeWindowEnabled ? 'checked' : ''}>
        <label for="active_window_enabled" style="margin:0">Only run during these hours</label>
        ${
          capacity?.shortfall
            ? `<span class="bang" title="Longer than the API can sustain — see the note above">!</span>`
            : ''
        }
      </p>
      <div class="row indent">
        <input type="time" name="active_start" value="${esc(settings.activeStart)}" required>
        <span style="padding-bottom:.5rem">to</span>
        <input type="time" name="active_end" value="${esc(settings.activeEnd)}" required>
        <span class="pill" style="margin-bottom:.45rem">${
          settings.activeWindowEnabled ? esc(hrs(windowHours(settings.activeStart, settings.activeEnd))) : '—'
        }/day</span>
      </div>
      <p class="sub indent" style="margin:.3rem 0 0">
        Outside these hours the bot does not call the X API at all, which is what conserves quota.
        A window may cross midnight — 22:00 to 06:00 is eight hours.
      </p>

      <label>Areas <span style="font-weight:400;color:var(--muted)">— a lesson matches if it mentions any one of these</span></label>
      <div class="areas">${KNOWN_AREAS.map(checkbox).join('')}</div>

      <label>Time range <span style="font-weight:400;color:var(--muted)">— the lesson plus the overrun buffer must fit entirely inside this</span></label>
      <div class="row">
        <input type="time" name="time_range_start" value="${esc(settings.timeRangeStart)}" required>
        <span style="padding-bottom:.5rem">to</span>
        <input type="time" name="time_range_end" value="${esc(settings.timeRangeEnd)}" required>
      </div>

      <label>Date range <span style="font-weight:400;color:var(--muted)">— leave blank for no limit</span></label>
      <div class="row">
        <input type="date" name="date_range_start" value="${esc(settings.dateRangeStart ?? '')}">
        <span style="padding-bottom:.5rem">to</span>
        <input type="date" name="date_range_end" value="${esc(settings.dateRangeEnd ?? '')}">
      </div>

      <label for="buffer">Overrun buffer (minutes)</label>
      <input id="buffer" type="number" name="overrun_buffer_minutes" min="0" max="180"
             value="${esc(settings.overrunBufferMinutes)}">
      <p class="sub" style="margin:.3rem 0 0">
        A 1–2pm lesson with a 30 minute buffer is treated as running until 2:30pm.
      </p>

      <p style="margin:1.2rem 0 0"><button type="submit">Save settings</button></p>
    </form>
  </div>`;
}

function timeCell(lesson) {
  const end = lesson.end_time ? `–${esc(lesson.end_time)}` : '';
  return `${esc(lesson.start_time)}${end}`;
}

function claimedTable(rows) {
  if (!rows.length) return `<p class="empty">Nothing claimed yet.</p>`;
  return `<div class="scroll-y"><table>
    <thead><tr><th>Date</th><th>Time</th><th>Areas</th><th>Email sent</th></tr></thead>
    <tbody>${rows
      .map(
        (l) => `<tr>
          <td>${esc(l.lesson_date)}</td>
          <td>${timeCell(l)}</td>
          <td>${esc(l.areas.join(', '))}</td>
          <td>${esc(l.email_sent_at ?? '—')} <span class="pill">${esc(ago(l.email_sent_at) ?? '')}</span></td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function skippedTable(rows) {
  if (!rows.length) return `<p class="empty">Nothing skipped.</p>`;
  return `<div class="scroll-y"><table>
    <thead><tr><th>Date</th><th>Time</th><th>Areas</th><th>Why not claimed</th></tr></thead>
    <tbody>${rows
      .map(
        (l) => `<tr>
          <td>${esc(l.lesson_date)}</td>
          <td>${timeCell(l)}</td>
          <td>${esc(l.areas.join(', '))}</td>
          <td><span class="pill">${esc(SKIP_REASON_LABELS[l.skip_reason] ?? l.skip_reason ?? l.status)}</span></td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

function errorTable(rows) {
  if (!rows.length) return `<p class="empty">No errors. </p>`;
  return `<div class="scroll-y"><table>
    <thead><tr><th>When</th><th>Stage</th><th>Message</th></tr></thead>
    <tbody>${rows
      .map(
        (e) => `<tr>
          <td>${esc(e.occurred_at)}</td>
          <td><span class="pill">${esc(e.stage)}</span></td>
          <td>${esc(e.message)}
            ${e.raw_context ? `<details><summary>context</summary><pre>${esc(e.raw_context)}</pre></details>` : ''}
          </td>
        </tr>`,
      )
      .join('')}</tbody></table></div>`;
}

export function dashboardPage(model) {
  const { settings, claimed, skipped, errors, health, flash, capacity } = model;

  return page(
    'drivers-ed dashboard',
    `<h1>Needham Driving School — drivers-ed</h1>
     <p class="sub">Watching <strong>@NeedhamDriving</strong> · polling every ${esc(
       health.pollIntervalSeconds,
     )}s · <a href="/logout">sign out</a></p>
     <p class="sub" style="margin-top:-.9rem">
       Running since ${esc(health.startedAt?.replace('T', ' ').slice(0, 19) ?? 'unknown')} UTC
       (${esc(ago(health.startedAt) ?? '')}) ·
       config from <code>${esc((health.configFiles ?? []).join(', ') || 'no .env found')}</code><br>
       <span style="opacity:.85">Editing that file changes nothing until you run
       <code>sudo systemctl restart drivers-ed</code>. Areas, times and dates below are stored in
       the database and apply immediately.</span>
     </p>

     ${offBanner(settings, skipped)}
     ${healthBanner(health)}
     ${flash?.notify ? `<div class="banner ${flash.notify.ok ? 'ok' : 'bad'}">${esc(flash.notify.message)}</div>` : ''}

     ${settingsForm(settings, flash ?? {}, capacity, health.timezone)}

     <div class="card">
       <h2>Claimed — we emailed in time (${claimed.length})</h2>
       <p class="sub" style="margin:-.4rem 0 .8rem">
         This means the claim email was sent, not that the school assigned you the lesson.
       </p>
       ${claimedTable(claimed)}
       ${
         claimed.length
           ? `<div class="rowactions">
                <form method="post" action="/lessons/clear-claimed">
                  <button class="secondary" type="submit">Clear these ${claimed.length} record(s)</button>
                </form>
                <span class="sub" style="margin:0">
                  Careful: this is the only record that an email was sent. If the school re-posts
                  an identical lesson afterwards, the bot will email again.
                </span>
              </div>`
           : ''
       }
     </div>

     <div class="card">
       <h2>Seen but not claimed (${skipped.length})</h2>
       <p class="sub" style="margin:-.4rem 0 .8rem">
         Clearing forgets these lessons entirely. A later post offering the same date, time and
         towns is then treated as brand new and can be claimed — useful for wiping test data so
         it cannot shadow a real lesson.
       </p>
       ${skippedTable(skipped)}
       ${
         skipped.length
           ? `<div class="rowactions">
                <form method="post" action="/lessons/clear-skipped">
                  <button class="secondary" type="submit">Clear these ${skipped.length} lesson(s)</button>
                </form>
                <span class="sub" style="margin:0">Claimed lessons are not touched.</span>
              </div>`
           : ''
       }
     </div>

     <div class="card">
       <h2>Errors (${errors.length})</h2>
       ${errorTable(errors)}
       <p style="margin-top:1rem;display:flex;gap:.6rem;flex-wrap:wrap">
         <form method="post" action="/errors/clear"><button class="secondary" type="submit">Clear errors</button></form>
         <form method="post" action="/test-notification"><button class="secondary" type="submit">Send test phone notification</button></form>
       </p>
     </div>`,
  );
}
