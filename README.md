# drivers-ed — Needham Driving School lesson auto-claim bot

Watches **@NeedhamDriving** on X. When a post announces an open lesson that matches your
criteria, it emails `info@needhamdrivingschool.com` from your Gmail to claim it, then pushes a
notification to your phone the moment the email is confirmed sent. A password-protected
dashboard lets you change the criteria, flip the bot on and off, and see exactly what happened.

Everything runs as **one Node process** on **one small VPS**, under systemd, behind Caddy.
One SQLite file. No split services.

---

## ⚠️ Read this first: what is untested

I built and tested everything I could without your credentials. Three integrations call
external services, and **I have never made a single real call to any of them.** They are
written against current vendor documentation, but treat the first live run as the real test.

| Component | Status | How you verify it |
|---|---|---|
| SQLite schema, dedupe, status transitions | **Tested** — 94 automated tests | `npm test` |
| Post parser (regex path) | **Tested** against the example post + 15 variants | `npm test` |
| Matching, every skip reason, atomic double-send guard | **Tested** | `npm test` |
| Full pipeline end-to-end (parse → match → send → notify) | **Tested** with fakes | `npm run replay` |
| **X API polling** | ❌ **UNTESTED** — no bearer token was ever used | §6 step 1 below |
| **Gmail SMTP send** | ❌ **UNTESTED** — no email was ever sent | §6 step 2 below |
| **Claude Haiku parser** | ❌ **UNTESTED** — no API call was ever made | §6 step 3 below |
| **ntfy push** | ❌ **UNTESTED** — no push was ever delivered | Dashboard "Send test notification" |
| systemd unit / Caddy config | ❌ **UNTESTED** — never run on a real Ubuntu box | §5 below |

The regex parser, the database layer, and all the matching logic are genuinely exercised. The
network edges are not. §6 is a deliberate order for testing them one at a time so a failure
tells you exactly which one broke.

---

## 1. What you need to create

Work through these before deploying. Nothing here goes in the repo — every secret lands in a
`.env` file on the server (§4).

- [ ] **A VPS.** DigitalOcean or Hetzner, smallest Ubuntu 24.04 droplet (~$5/mo). You need SSH access.
- [ ] **An X developer account** → an app → an **app-only Bearer Token**.
      X is pay-per-use since Feb 2026: **credits are prepaid**, minimum **$5**. At your volume
      (~90 posts/month × $0.005) that is about **$0.45/month**, so $5 lasts roughly a year.
      **If your credit balance hits zero the API stops returning posts and the bot goes blind** —
      the dashboard shows a loud red banner if this happens, but set a calendar reminder too.
- [ ] **A Gmail App Password** for `jaydenaleung@gmail.com`. Requires 2-Step Verification to be
      enabled first: Google Account → Security → 2-Step Verification → App passwords.
      You get a 16-character string. **This is not your Google password** — do not use that.
- [ ] **An Anthropic API key** (optional but recommended — you chose to include the Haiku parser).
      Without it the bot runs regex-only and says so on the dashboard. Under $1/month.
- [ ] **The ntfy app** on your phone (iOS/Android), subscribed to a topic name you invent.
      **ntfy topics are public to anyone who guesses the name** — generate a random one, don't
      pick "jayden-lessons".
- [ ] **A dashboard password** you choose.
- [ ] **Optional: a domain name** pointed at the droplet's IP. Without one you get a browser
      certificate warning (see Option B in `deploy/Caddyfile`); with one you get real HTTPS free.
- [ ] **Optional: a test X account** to post fake lesson announcements from (see §6 step 1).

### Secrets to generate

Run these locally or on the server and keep the output — you will paste them into `.env`:

```bash
openssl rand -hex 16
```
That is your `NTFY_TOPIC` (long and unguessable, as required).

```bash
openssl rand -hex 32
```
That is your `SESSION_SECRET` (signs the dashboard login cookie).

### Finding the numeric X user ID

`X_ACCOUNT_USER_ID` is a number, **not** the `@NeedhamDriving` handle. Once you have your
bearer token:

```bash
curl -s -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  "https://api.x.com/2/users/by/username/NeedhamDriving"
```

The `data.id` field in the response is the value you want. (This call itself costs a fraction
of a cent.)

---

## 2. Try it locally first (no accounts needed)

Before touching a server, prove the logic works on your own machine. This needs only Node 22+.

```bash
npm install
```

```bash
npm test
```

```bash
npm run replay
```

`npm run replay` pushes the fixture posts in `fixtures/replay-posts.json` through the complete
pipeline — parser, dedupe, claim notices, matching, send, notify — with email and push forced
into dry-run. You should see two lessons claimed, one closed by a claim notice, one post
ignored, and one malformed opening surfacing as a logged error rather than disappearing.

To see how the bot reads any specific piece of text:

```bash
npm run parse -- "Lesson Open Today: 1-2 pm Needham/Wellesley Email to claim this hour."
```

---

## 3. Deploy to a fresh Ubuntu droplet

Assumes Ubuntu 24.04 and that you can `ssh root@YOUR_SERVER_IP`. Run everything as root unless
noted. Replace `YOUR_SERVER_IP` and `bot.example.com` throughout.

### 3.1 Basic server setup

```bash
apt update && apt upgrade -y
```

Install Node 22 from NodeSource (Ubuntu's own `nodejs` package is too old):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs git
```

Confirm you got v22 or newer:

```bash
node --version
```

### 3.2 Create an unprivileged user for the bot

The bot never needs root. If it is ever compromised, this limits the damage.

```bash
adduser --system --group --home /opt/drivers-ed driversed
```

### 3.3 Get the code onto the server

```bash
git clone https://github.com/jaydenaleung/drivers-ed.git /opt/drivers-ed
```

```bash
cd /opt/drivers-ed && npm install --omit=dev
```

Create the data directory and hand everything to the bot user:

```bash
mkdir -p /opt/drivers-ed/data && chown -R driversed:driversed /opt/drivers-ed
```

### 3.4 Create the secrets file

```bash
cp /opt/drivers-ed/.env.example /opt/drivers-ed/.env
```

```bash
nano /opt/drivers-ed/.env
```

Fill in every value from §1. **Leave `DRY_RUN=true` for now** — you will flip it in §6 once
each integration is proven.

Lock the file down so only the bot user can read it:

```bash
chown driversed:driversed /opt/drivers-ed/.env && chmod 600 /opt/drivers-ed/.env
```

### 3.5 Install the systemd service

This is what makes the bot start on boot and restart if it crashes.

```bash
cp /opt/drivers-ed/deploy/drivers-ed.service /etc/systemd/system/
```

```bash
systemctl daemon-reload && systemctl enable --now drivers-ed
```

Check it came up:

```bash
systemctl status drivers-ed
```

You want `Active: active (running)`. Watch the live log:

```bash
journalctl -u drivers-ed -f
```

Press `Ctrl+C` to stop watching (the service keeps running).

### 3.6 Install Caddy for HTTPS

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
```

```bash
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
```

```bash
apt update && apt install -y caddy
```

Now put your config in place and edit the domain:

```bash
cp /opt/drivers-ed/deploy/Caddyfile /etc/caddy/Caddyfile
```

```bash
nano /etc/caddy/Caddyfile
```

Replace `bot.example.com` with your real domain. **If you don't have a domain**, comment out
the whole Option A block and uncomment Option B, putting your server's IP in it.

```bash
systemctl reload caddy
```

Caddy fetches a certificate automatically within a few seconds. Check for problems with
`journalctl -u caddy -n 50`.

### 3.7 Firewall

Only SSH and web traffic should be reachable. The bot's own port 8080 stays on loopback and is
never exposed.

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

### 3.8 Open the dashboard

Visit `https://bot.example.com` (or `https://YOUR_SERVER_IP` for Option B). You should get the
password prompt. Log in with `DASHBOARD_PASSWORD`.

---

## 4. Environment variables

All of these live in `/opt/drivers-ed/.env`. See `.env.example` for the annotated template.

| Variable | Required | What it is |
|---|---|---|
| `X_BEARER_TOKEN` | yes | App-only bearer token from the X developer console |
| `X_ACCOUNT_USER_ID` | yes | Numeric ID of @NeedhamDriving (see §1) |
| `GMAIL_ADDRESS` | yes | `jaydenaleung@gmail.com` |
| `GMAIL_APP_PASSWORD` | yes | 16-char Google App Password, no spaces |
| `CLAIM_EMAIL_TO` | no | Defaults to `info@needhamdrivingschool.com` |
| `CLAIM_FROM_NAME` | no | Defaults to `Jayden Leung` |
| `ANTHROPIC_API_KEY` | no | Enables the Haiku parser; regex-only if blank |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-haiku-4-5` |
| `NTFY_TOPIC` | yes | Random unguessable string |
| `NTFY_SERVER` | no | Defaults to `https://ntfy.sh` |
| `DASHBOARD_PASSWORD` | yes | Dashboard login |
| `SESSION_SECRET` | yes | Signs the login cookie — `openssl rand -hex 32` |
| `PORT` / `HOST` | no | Default `8080` / `127.0.0.1`. Leave the host on loopback. |
| `DATABASE_PATH` | no | Defaults to `./data/driversed.db` |
| `POLL_INTERVAL_SECONDS` | no | Default `10`. See the note in §8. |
| `TIMEZONE` | no | Default `America/New_York` |
| `DRY_RUN` | no | Default `true`. **Flip to `false` to actually send.** |
| `POST_SOURCE` | no | `x` (live) or `replay` (offline fixture) |

The bot refuses to start if a required variable is missing and tells you which one.

---

## 5. Restarting after a config change

Any `.env` edit needs a restart:

```bash
systemctl restart drivers-ed
```

To deploy new code:

```bash
cd /opt/drivers-ed && git pull && npm install --omit=dev && systemctl restart drivers-ed
```

---

## 6. Proving the untested integrations, one at a time

Do these in order. Each step isolates one external service so a failure is unambiguous.
Keep `DRY_RUN=true` until step 4.

### Step 1 — X polling, against a test account

Do **not** point at the real driving school account yet.

1. Create a throwaway X account and post a fake message:
   `Lesson Open Today: 1-2 pm Needham/Wellesley Email to claim this hour.`
2. Get its numeric ID with the curl command in §1.
3. Put that ID in `X_ACCOUNT_USER_ID`, restart, and watch the log.

**Expected:** on the very first poll the bot logs
`First run — recorded the current newest post and skipped it.` This is deliberate — it prevents
the bot firing off claim emails for days-old posts on startup. Post a *new* fake lesson, and
within ~10 seconds you should see `[post ...] lesson_recorded` and the lesson on the dashboard.

**If it fails:** a 401 means the bearer token is wrong. A message about credits means you have
not bought any. Anything else surfaces in the dashboard error feed.

### Step 2 — Gmail SMTP

With the test lesson sitting in the dashboard, set `DRY_RUN=false`, make sure your criteria
actually match it, and restart. Within one poll cycle you should get
`[claim] emailed for lesson ...` in the log and a real email in
`info@needhamdrivingschool.com`.

⚠️ **This sends a real email to the real driving school.** Either point `CLAIM_EMAIL_TO` at
your own address for this test, or accept that the school gets one odd message. I'd point it
at yourself first.

**If it fails:** `Invalid login` almost always means the App Password is wrong, has spaces in
it, or 2-Step Verification is not actually enabled.

### Step 3 — Haiku parser

Locally, with `ANTHROPIC_API_KEY` set in a local `.env`:

```bash
npm run parse -- "we've got a last-minute cancellation this afternoon, 3 til 4:30, wellesley area — first to email gets it"
```

That wording is deliberately nothing like the template. The regex parser will likely miss the
areas or times; Haiku should get them. The output tells you which parser ran.

**If it fails:** the tool prints the error and falls back to regex, which is exactly what the
bot does in production. A broken Haiku key degrades the bot, it does not stop it.

### Step 4 — ntfy

Click **Send test notification** on the dashboard. Your phone should buzz within a couple of
seconds. If nothing arrives, check that the topic in the app matches `NTFY_TOPIC` exactly.

### Step 5 — Failure handling

Deliberately break the bearer token in `.env` and restart. Confirm the bot **keeps running**
and the error appears in the dashboard error feed rather than crashing the process. Then fix it.

### Step 6 — systemd restart

```bash
systemctl kill -s SIGKILL drivers-ed
```

Then `systemctl status drivers-ed` — it should be running again within ~5 seconds.

### Step 7 — Go live

Swap `X_ACCOUNT_USER_ID` to the real @NeedhamDriving ID, set `CLAIM_EMAIL_TO` back to the
school, confirm `DRY_RUN=false`, set your real criteria on the dashboard, turn the bot **ON**,
and restart.

---

## 7. Day-to-day

**See what it's doing:**
```bash
journalctl -u drivers-ed -f
```

**Recent errors only:**
```bash
journalctl -u drivers-ed -p err -n 50
```

**Is it alive?** The dashboard shows a green/red banner with the time of the last successful
poll. There is also an unauthenticated `GET /healthz` returning JSON — point a free
[healthchecks.io](https://healthchecks.io) or UptimeRobot monitor at it and you'll get an email
if the bot goes silent (§9 of the spec's optional dead-man's switch).

**Back up the database:**
```bash
sqlite3 /opt/drivers-ed/data/driversed.db ".backup '/root/driversed-backup.db'"
```

---

## 8. Design notes worth knowing

**Poll interval defaults to 10s, not the 15–30s in the original spec.** The X endpoint allows
10,000 requests per 15 minutes on an app-only token; a 10-second loop uses 90 of them. Polls
that return nothing are not billed, so faster polling costs nothing but CPU. If you want to go
to 5s, you still use under 2% of the rate limit.

**The first poll deliberately ignores what it sees.** Otherwise every restart would treat the
existing timeline as brand new and email about lessons that are long gone.

**Double-sends are prevented by SQLite, not by convention.** Before any email is sent, the
lesson row is flipped to `sending` with a single atomic `UPDATE ... WHERE status IN ('open',
'skipped_no_match')`. If that statement reports zero rows changed, something else already took
it and no email goes out. There is no `await` between the check and the write.

**A skipped lesson is not written off.** If the bot skips a lesson because the area wasn't
ticked, and you tick it thirty seconds later, the next sweep claims it — as long as the school
hasn't announced it as taken. Only `claimed_by_school` and `email_sent` are terminal.

**A failed email retries.** Per spec §6, an SMTP failure puts the lesson back to `open` and
logs the error, so a transient network blip doesn't cost you a real opening.

**A failed phone notification changes nothing.** Per spec §7, it is logged and ignored.

**Time matching uses your overrun rule.** A lesson is treated as running from its start time
until its stated end **plus a 30-minute buffer** (configurable on the dashboard), and that
whole window must fit *entirely* inside your selected range. A 1–2pm lesson is treated as
1:00–2:30 and needs a range of at least 1:00–2:30 to match. If a post gives a start time but no
end time, the lesson is assumed to run one hour before the buffer is applied.

**Area matching is "any".** A "Needham/Wellesley" lesson matches if you have ticked either one.

---

## 9. Costs

| Item | Per month |
|---|---|
| VPS (smallest droplet) | $4–6 |
| X API reads (~90 posts) | ~$0.45, prepaid in $5 blocks |
| Claude Haiku parsing | under $1 |
| Gmail SMTP, ntfy.sh, Caddy/Let's Encrypt | $0 |
| Domain (optional) | ~$1 amortised |
| **Total** | **~$5–8**, almost entirely the VPS |

---

## 10. Known limitations

- **"Claimed" means "we emailed in time."** The bot cannot confirm the school actually assigned
  the lesson to you.
- **10-second polling is not instantaneous.** If lessons are being taken within seconds of
  posting, the next step up is a third-party relay like twitterapi.io layered *on top of* this
  polling (not replacing it — it is an unofficial reseller that could vanish without notice).
- **One VPS is a single point of failure.** Use the `/healthz` monitor so you find out quickly.
- **Prepaid X credits can run out silently.** The dashboard shows a red banner, but it can only
  do so if you look at it.
- **The parser's non-template handling is unproven against real posts.** The spec referenced two
  example post formats but only contained one; the variants in the test suite are my
  guesses at the school's wording. Feed real examples through `npm run parse` and tell me where
  it's wrong.
- **Threads is not monitored**, per the scope decision in the spec.
