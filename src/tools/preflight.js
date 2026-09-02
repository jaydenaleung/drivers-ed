/**
 * Preflight — proves every external integration works, without sending a claim
 * email and without needing a server.
 *
 *   npm run preflight
 *
 * Run it on your own laptop FIRST. Everything except the host's firewall
 * behaves identically there, so you can confirm your X token, Gmail App
 * Password, Anthropic key and ntfy topic all work before spending anything on
 * hosting. Then run the same command on the server: the only check that can
 * differ is TCP 587, which is the one thing a host can block.
 *
 * Nothing here is destructive. No claim email is sent unless you explicitly
 * pass --send-test-email.
 */
import net from 'node:net';
import { config, haikuEnabled } from '../config.js';

const SEND_TEST_EMAIL = process.argv.includes('--send-test-email');
const SKIP_X = process.argv.includes('--skip-x');
const SKIP_HAIKU = process.argv.includes('--skip-haiku');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const results = [];

function record(name, ok, detail, hint) {
  results.push({ name, ok, detail, hint });
  const mark =
    ok === true ? `${GREEN}PASS${OFF}` : ok === 'skip' ? `${YELLOW}SKIP${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark}  ${name.padEnd(24)} ${detail}`);
  if (ok === false && hint) console.log(`        ${DIM}${hint}${OFF}`);
}

/** Raw TCP reachability — this is precisely what a blocking host breaks. */
function checkTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok, reason) => {
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, 'timed out — this is what a blocked port looks like'));
    socket.once('error', (err) => done(false, err.code || err.message));
    socket.connect(port, host);
  });
}

console.log('\nPreflight — checking every external service this bot depends on.\n');

// "The value is missing" and "you edited a different file than the one this
// process reads" look identical without this line.
if (config.loadedEnvFiles.length === 0) {
  console.log(`  ${RED}No .env or .env.local found in ${config.root}${OFF}`);
} else {
  console.log(`  ${DIM}config loaded from: ${config.loadedEnvFiles.join(', ')}${OFF}`);
}
console.log('');

// --- 1. Configuration -------------------------------------------------------
{
  const missing = [];
  if (!config.x.bearerToken) missing.push('X_BEARER_TOKEN');
  if (!config.x.accountUserId) missing.push('X_ACCOUNT_USER_ID');
  if (!config.email.address) missing.push('GMAIL_ADDRESS');
  if (!config.email.appPassword) missing.push('GMAIL_APP_PASSWORD');
  if (!config.ntfy.topic) missing.push('NTFY_TOPIC');

  record(
    'Configuration',
    missing.length === 0,
    missing.length === 0 ? 'all required values present' : `missing: ${missing.join(', ')}`,
    'Copy .env.example to .env and fill it in. See README section 1.',
  );
}

// --- 2. Outbound TCP 587 — the check a host can fail ------------------------
{
  const { ok, reason } = await checkTcp('smtp.gmail.com', 587);
  record(
    'TCP 587 to Gmail',
    ok,
    ok ? 'reachable — this machine does not block SMTP submission' : `unreachable: ${reason}`,
    'THIS is the check that disqualifies a host. If it fails on a server but passed on your\n' +
      '        laptop, the host blocks outbound SMTP and the bot can never send. Switch hosts.',
  );
}

// --- 3. Gmail SMTP authentication (no message sent by default) --------------
if (config.email.address && config.email.appPassword) {
  try {
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: config.email.address, pass: config.email.appPassword },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });

    await transport.verify();
    record('Gmail SMTP login', true, `authenticated as ${config.email.address} — no email sent`);

    if (SEND_TEST_EMAIL && /needhamdrivingschool\.com/i.test(config.email.to)) {
      record(
        'Test email',
        false,
        `REFUSED — CLAIM_EMAIL_TO is the driving school (${config.email.to})`,
        'A test message must never reach the school. Point CLAIM_EMAIL_TO at your own address while testing, then switch it back when you go live.',
      );
    } else if (SEND_TEST_EMAIL) {
      const info = await transport.sendMail({
        from: `"${config.email.fromName}" <${config.email.address}>`,
        to: config.email.to,
        subject: 'drivers-ed preflight test (please ignore)',
        text: 'Test message from the lesson bot preflight check. No action needed.',
      });
      record(
        'Test email',
        Boolean(info.accepted?.length),
        `delivered to ${config.email.to} (${info.messageId})`,
      );
    } else {
      record('Test email', 'skip', 'not sent — pass --send-test-email to send one');
    }
  } catch (err) {
    const looksBlocked = /ETIMEDOUT|ECONNREFUSED|ESOCKET|EHOSTUNREACH/i.test(err.message);
    record(
      'Gmail SMTP login',
      false,
      err.message,
      looksBlocked
        ? 'This looks like a network or port block rather than bad credentials.'
        : 'Usually a wrong App Password, spaces left in it, or 2-Step Verification not enabled.\n' +
          '        It must be a 16-character App Password, not your Google account password.',
    );
  }
} else {
  record('Gmail SMTP login', 'skip', 'GMAIL_ADDRESS / GMAIL_APP_PASSWORD not set');
}

// --- 4. X API ---------------------------------------------------------------
if (SKIP_X) {
  record('X API read', 'skip', '--skip-x given');
} else if (config.x.bearerToken && config.x.accountUserId) {
  try {
    const url = new URL(`https://api.x.com/2/users/${config.x.accountUserId}/tweets`);
    url.searchParams.set('max_results', '5');
    url.searchParams.set('tweet.fields', 'created_at');
    url.searchParams.set('exclude', 'retweets');

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.x.bearerToken}` },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text();

    if (res.ok) {
      const json = JSON.parse(body);
      const n = json?.data?.length ?? 0;
      record('X API read', true, `fetched ${n} recent post(s) — costs about $${(n * 0.005).toFixed(3)}`);
      if (n > 0) {
        const preview = String(json.data[0].text).replace(/\s+/g, ' ').slice(0, 66);
        console.log(`        ${DIM}newest: "${preview}..."${OFF}`);
      }
    } else {
      const credits = /CreditsDepleted|insufficient credit/i.test(body) || res.status === 402;
      record(
        'X API read',
        false,
        `HTTP ${res.status}`,
        credits
          ? 'Your prepaid X credit balance is empty. Buy credits in the developer console ($5 min).'
          : res.status === 401
            ? 'Bearer token rejected. X_BEARER_TOKEN must be the app-only Bearer Token.'
            : res.status === 404
              ? 'User not found. X_ACCOUNT_USER_ID must be the NUMERIC id, not the @handle.'
              : body.slice(0, 180),
      );
    }
  } catch (err) {
    record('X API read', false, err.message, 'Network problem reaching api.x.com.');
  }
} else {
  record('X API read', 'skip', 'X_BEARER_TOKEN / X_ACCOUNT_USER_ID not set');
}

// --- 5. Claude Haiku parser -------------------------------------------------
if (SKIP_HAIKU) {
  record('Claude Haiku parser', 'skip', '--skip-haiku given — no Anthropic API call made');
} else if (haikuEnabled(config)) {
  try {
    const { parseWithHaiku } = await import('../parser/haiku.js');
    // Deliberately off-template wording: regex struggles here, Haiku should not.
    const sample =
      "we've got a last-minute cancellation this afternoon, 3 til 4:30, wellesley area - first to email gets it";
    const parsed = await parseWithHaiku(sample, { postedOnDate: '2026-07-27' });
    const ok = parsed.is_lesson_opening && parsed.start_time === '15:00';

    record(
      'Claude Haiku parser',
      ok,
      ok
        ? `parsed an off-template post correctly (${parsed.start_time}-${parsed.end_time}, ${parsed.areas.join('/')})`
        : `API worked but the result looked wrong: ${JSON.stringify(parsed)}`,
      ok
        ? null
        : 'The API call itself succeeded, so your key is fine. Send me this output — the prompt needs tuning.',
    );
  } catch (err) {
    record(
      'Claude Haiku parser',
      false,
      err.message,
      'Not fatal — the bot falls back to regex without this, just less robust on odd wording.',
    );
  }
} else {
  record('Claude Haiku parser', 'skip', 'ANTHROPIC_API_KEY not set — bot runs regex-only');
}

// --- 6. ntfy push -----------------------------------------------------------
if (config.ntfy.topic) {
  try {
    const { sendTestNotification } = await import('../notify.js');
    const result = await sendTestNotification();
    record(
      'ntfy push',
      result.ok,
      result.ok ? 'sent — check your phone now' : result.error,
      'Confirm the topic subscribed in the ntfy app exactly matches NTFY_TOPIC.',
    );
  } catch (err) {
    record('ntfy push', false, err.message);
  }
} else {
  // Deliberately a FAIL, not a SKIP. "skip" reads as "we chose not to run
  // this", but a missing NTFY_TOPIC means the phone push silently will not
  // work — and being told the moment a lesson is claimed is the whole point.
  record(
    'ntfy push',
    false,
    'NTFY_TOPIC is empty or missing',
    'Add NTFY_TOPIC to the config file listed at the top of this output, then restart.\n' +
      '        Note the server reads /opt/drivers-ed/.env — not the .env.local on your laptop.',
  );
}

// --- summary ----------------------------------------------------------------
const failed = results.filter((r) => r.ok === false);
const skipped = results.filter((r) => r.ok === 'skip');

console.log('');
if (failed.length === 0) {
  console.log(`${GREEN}All checks passed.${OFF} Every service this bot depends on is reachable and`);
  console.log(`authenticated from this machine${skipped.length ? ` (${skipped.length} skipped)` : ''}.`);
  console.log('');
  console.log('Ran this on your laptop? The only thing a server can change is TCP 587.');
  console.log('Run the same command on the server as your first step after it boots.');
} else {
  console.log(`${RED}${failed.length} check(s) failed:${OFF} ${failed.map((f) => f.name).join(', ')}`);
  console.log('Fix these before setting DRY_RUN=false. Nothing was sent to the driving school.');
}
console.log('');

process.exit(failed.length === 0 ? 0 : 1);
