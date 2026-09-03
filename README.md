# drivers-ed — Needham Driving School lesson auto-claim bot

Watches **@NeedhamDriving** on X. When a post announces an open lesson that matches your
criteria, it emails `info@needhamdrivingschool.com` from your Gmail to claim it, then pushes a
notification to your phone the moment the email is confirmed sent. A password-protected
dashboard lets you change the criteria, flip the bot on and off, and see exactly what happened.

Everything runs as **one Node process** on **one small VPS**, under systemd, behind Caddy.
One SQLite file. No split services.

---

## ⚠️ Read this first: what is untested

Most integrations are now verified against live credentials. The two remaining gaps are the
Haiku parser (the API key currently on file is rejected) and the server-side deployment.

| Component | Status | How you verify it |
|---|---|---|
| SQLite schema, dedupe, status transitions | **Tested** — 94 automated tests | `npm test` |
| Post parser (regex path) | ✅ **Rebuilt and verified against 10 REAL posts** (2026-09-01) | `npm test` |
| Matching, every skip reason, atomic double-send guard | **Tested** | `npm test` |
| Full pipeline end-to-end (parse → match → send → notify) | **Tested** with fakes | `npm run replay` |
| **X API polling** | ✅ **VERIFIED 2026-09-01** — fetched 5 real posts from @NeedhamDriving | `npm run preflight` (§2.1) |
| **Gmail SMTP send** | ✅ **VERIFIED 2026-09-01** — real message delivered via App Password | `npm run preflight` (§2.1) |
| **Claude Haiku parser** | ❌ **UNTESTED** — the current ANTHROPIC_API_KEY is rejected as invalid | `npm run preflight` (§2.1) |
| **ntfy push** | ✅ **VERIFIED 2026-09-01** — push delivered to the phone | `npm run preflight` (§2.1) |
| systemd unit / Caddy config | ❌ **UNTESTED** — never run on a real Ubuntu box | §5 below |

The regex parser, the database layer, and all the matching logic are genuinely exercised. The
network edges are not. §6 is a deliberate order for testing them one at a time so a failure
tells you exactly which one broke.

---

## 1. What you need to create

Work through these before deploying. Nothing here goes in the repo — every secret lands in a
`.env` file on the server (§4).

- [ ] **A VPS that allows outbound SMTP on port 587.** This is not optional and not
      negotiable: it is how the bot sends the claim email.
      **Do NOT use DigitalOcean** — it blocks outbound ports 25, 465 *and* 587 by default on
      all droplets, and frequently declines to unblock them. The spec recommended it; that
      recommendation is wrong for this project.
      **If you have Google Cloud trial credit, use that** (Google documents 587 as
      unrestricted; free for 90 days). Otherwise **RackNerd** ($21.99/year) or **Hetzner**
      (~€6/mo, 587 open by documented policy). Free tiers do not work: Oracle blocks 587, and
      GCP/AWS/Azure now charge ~$3.65/mo for the public IP. See §11 for a full walkthrough.
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
- [ ] **A hostname for the dashboard.** A free `*.duckdns.org` subdomain gets you a real,
      browser-trusted HTTPS certificate for $0/year, which is all this private dashboard needs.
      Buy a real domain only if you want a nicer name. See §11.
- [ ] **Optional: a test X account** to post fake lesson announcements from (see §6 step 1).

> **You cannot run this on zero spend.** Whatever host you pick, the X API requires a $5
> minimum prepaid credit purchase before it will return any posts.

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

### 2.1 Prove every integration works BEFORE you pay for hosting

You do not have to buy a server and hope. Every external service this bot uses can be tested
from your own laptop, because nothing about them depends on where the code runs:

```bash
npm run preflight
```

It checks, and tells you exactly what is wrong with each:

| Check | What it proves |
|---|---|
| Configuration | Every required `.env` value is present |
| **TCP 587 to Gmail** | This machine can open an SMTP submission connection at all |
| Gmail SMTP login | Your App Password actually authenticates (**no email is sent**) |
| X API read | Your bearer token and numeric user ID work against the real endpoint |
| Claude Haiku parser | Your Anthropic key works, on a deliberately off-template post |
| ntfy push | A real notification lands on your phone |

Nothing destructive happens. No claim email is sent unless you add `--send-test-email`, and
even then it goes to whatever `CLAIM_EMAIL_TO` is set to — point that at your own address first.

**This is the answer to "how do I know it'll work before I pay?"** Run it on your laptop with a
`.env` you have filled in. If every line says PASS, then the only thing a server can possibly
change is the one check that depends on the host's firewall: **TCP 587**. Everything else —
credentials, tokens, the parser, the push — is already proven.

Then, the moment your server boots, run the exact same command on it. If TCP 587 passes there
too, the bot will work. If it fails, you know within 60 seconds, before you have configured
anything else — and on an hourly-billed host like Hetzner you can destroy the server and pay
about one cent.

### 2.2 What the real posts actually look like

The spec contained one example post, and it was **not representative**. Ten real posts pulled
from @NeedhamDriving on 2026-09-01 are archived in `fixtures/real-posts.json`, and the parser is
built and regression-tested against them. Two things differ from the spec:

**1. The school writes "Lessons" (plural), always.** The first parser required the singular and
therefore rejected 100% of real opening posts while passing every test written from the spec.

**2. One post advertises many lessons, one per line.** For example:

```
Lessons available on Sunday, 8/30!

8 am, 9 am, 10 am or 11 am - Needham, Westwood or Dover
9 am, 1 pm or 2 pm - Needham, Westwood or Dedham
9 am - Needham or Wellesley

Email info@needhamdrivingschool.com to claim!
```

That is **eight** separate claimable lessons. Note that 9am appears on all three lines with
different towns each time — those are three different lessons, and merging their towns would
invent lessons that do not exist while hiding ones that do. A second line format also occurs:

```
5-6 pm Needham/Westwood/Dover
```

The busiest post observed contained **eleven** lessons.

**Every matching lesson is claimed, all in ONE email.** A post can offer eleven hours and
several may fit your criteria; the bot puts them all into a single comma-separated message
rather than sending one email per hour. A single match still produces exactly the §6 template.

Note the email says "in Needham, Dedham **or** Westwood" — not "and". The school advertises a
slot as available in one of several towns, so "and" would be claiming a lesson that spans three
towns, which does not exist.

**Timing, from the real data:** every opening post was followed by a "claimed!" post within
**1 to 2 minutes**. At the default 10-second poll interval the bot sees an opening within ten
seconds, which is comfortably inside that window — but it is not a large margin, and it is the
reason the poll interval defaults to 10s rather than the 15–30s the spec suggested.

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

### 3.4 Get your secrets file onto the server

You already have a working `.env.local` on your laptop, so **do not retype it** — transfer it.
Retyping twenty values by hand is the single most likely way to introduce a typo you then spend
an hour hunting.

**Two rules regardless of method:**

1. **On the server the file must be named `.env`** (not `.env.local`). The systemd unit reads
   `/opt/drivers-ed/.env` specifically.
2. **Keep Unix (LF) line endings.** If the file ever gets CRLF endings, systemd's
   `EnvironmentFile` parser leaves a stray carriage return on the end of every value, and you
   get baffling failures like an App Password that is "wrong" despite looking correct. If you
   edit it in a Windows editor, set the editor to LF, or run `dos2unix /opt/drivers-ed/.env`
   on the server afterwards.

#### Method A — Google Cloud browser SSH (easiest, no tools to install)

1. In the Cloud console, click **SSH** next to the VM to open the browser terminal.
2. Click the **gear icon** (top right of that window) → **Upload file**.
3. Select your local `.env.local`. It lands in your home directory, e.g. `/home/you/.env.local`.
4. In that same terminal, move it into place with the correct name, owner and permissions:

```bash
sudo mv ~/.env.local /opt/drivers-ed/.env && sudo chown driversed:driversed /opt/drivers-ed/.env && sudo chmod 600 /opt/drivers-ed/.env
```

#### Method B — `gcloud` from your own machine

If you have the Google Cloud CLI installed locally:

```bash
gcloud compute scp .env.local drivers-ed:~/.env.local --zone us-east1-b
```

Then SSH in and run the same `sudo mv ...` line from Method A.

#### Method C — plain `scp` (any non-GCP host)

```bash
scp .env.local root@YOUR_SERVER_IP:/opt/drivers-ed/.env
```

Then on the server:

```bash
chown driversed:driversed /opt/drivers-ed/.env && chmod 600 /opt/drivers-ed/.env
```

#### Method D — copy and paste (last resort)

Open `nano /opt/drivers-ed/.env` on the server, paste the contents of your local file, save with
`Ctrl+O` then `Ctrl+X`. Works fine in the GCP browser terminal, but check afterwards that no
long value got wrapped onto a second line — that is the usual failure with pasting.

#### After the transfer, whichever method you used

Confirm the permissions are right (`600` means only the bot user can read it):

```bash
ls -l /opt/drivers-ed/.env
```

Verify the file loaded correctly — this prints key names and value **lengths**, never the
secrets themselves, so it is safe to run anywhere:

```bash
cd /opt/drivers-ed && npm run env-check
```

Compare the character counts against what you saw on your laptop. If a value is shorter than
expected, the transfer truncated it.

Finally, make sure no stray copy is left lying around in your home directory:

```bash
ls -a ~ | grep -i env
```

#### Three values to change for the server

Edit with `sudo nano /opt/drivers-ed/.env`:

- **`DRY_RUN=true`** — leave it on for now. You flip it to `false` in §6 once each
  integration is proven from the server.
- **`CLAIM_EMAIL_TO`** — keep this pointed at your own address while testing. Change it to
  `info@needhamdrivingschool.com` only when you actually go live.
- **`HOST=127.0.0.1`** — leave as-is. Caddy is the only thing that should reach the app;
  binding to `0.0.0.0` would expose the dashboard directly, bypassing HTTPS.

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
it, or 2-Step Verification is not actually enabled. A *timeout* or `ETIMEDOUT` instead means
your host is blocking outbound port 587 — re-run the check in §11.3 step 6.

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

### Active hours

Under **Enable bot** on the dashboard there is **Only run during these hours**. Outside that
window the bot does not call the X API at all — that is the only thing that actually conserves
rate-limit quota, so the window gates the poll itself and not just the claiming. Lessons seen
earlier are still shown, marked *Outside the bot's active hours*, and are re-evaluated (and
claimed if they still match) the moment the window opens. A window may cross midnight.

Above it, the **Polling capacity** note answers one question: at your current
`POLL_INTERVAL_SECONDS`, how many hours a day can the API sustain? Every X rate cap is
`limit` requests per `window`, so a full bucket lasts `limit × interval` seconds — if that is
longer than the window it refills faster than you drain it and the cap never binds. If your
chosen window is longer than the capacity, the dashboard shows a red **!** and explains the gap,
but still lets you save it: the bot simply stops polling partway through and resumes when the cap
resets.

The figures come from the `x-rate-limit-*` (and, if this endpoint sends them,
`x-app-limit-24hour-*`) response headers on the last poll, and each line says whether it was
*measured from X* or taken *from the docs*. Nothing is assumed about a cap X has not reported.

Note what is deliberately **not** in that calculation: X bills per post *returned*, not per
request, so an idle poll is free. Your daily read cap and prepaid credit balance are therefore
unaffected by how often you poll, and folding them into an hours figure would answer a different
question than the one asked.

---

## 8. Design notes worth knowing

**Poll interval defaults to 10s.** X documents 3,500 requests per 15 minutes per app for
`GET /2/users/:id/tweets` (900 per user); an app-only bearer token gets the per-app figure. A
10-second loop uses 90 of them. Polls that return nothing are not billed, so faster polling
costs no money.

> **Corrected 3 Sep 2026.** This previously said 10,000 per 15 minutes, which was wrong. It did
> not change any conclusion — even 3-second polling is 300 requests per 15 minutes — but the
> number was not one X publishes.

**Money is not the constraint. Access is.** On 2 Sep 2026 the bot ran at 3 seconds for about
15 hours, made roughly 18,000 requests, and X answered `usage cap exceeded`. Nearly every one of
those requests returned nothing, so the *bill* was almost zero and the `MAX_POSTS_PER_DAY` guard
never came close to firing — but the bot was cut off and went blind for 14 hours. X does not
document a per-day request cap for this endpoint, so the limit that stopped it is not one that
can be looked up.

`MAX_REQUESTS_PER_DAY` (default 10,000) is the answer to that: a budget we enforce ourselves,
below the level that was refused. Hitting it pauses polling until UTC midnight with a visible
banner, which is strictly better than X deciding to stop answering. `npm run caps` shows the
budget, today's usage, and whatever cap figures X has actually reported in its response headers.

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

---

## 11. Choosing and creating the VPS and hostname

### 11.1 The constraint that decides everything: outbound port 587

The bot's whole job is sending an email through `smtp.gmail.com:587`. Most hosts block outbound
SMTP to stop spammers, and **a host that blocks 587 makes this project impossible** — the
poller, parser, dashboard and notifications will all look fine while the claim email silently
never leaves the server.

| Provider | Port 587 outbound | Real monthly cost | Verdict |
|---|---|---|---|
| **RackNerd** | Open (even port 25 is) | **~$1.83/mo**, billed $21.99 once a year | **Recommended.** |
| **Hetzner** | Open, documented policy | ~$6.50/mo | Best reliability if budget allows. |
| **DigitalOcean** | Blocked (25, 465 **and** 587), often refused on appeal | ~$6/mo | **Do not use.** Would silently break the bot. |
| **Oracle Cloud "Always Free"** | Blocked (25, 2525 **and** 587) | $0 | Unusable despite being free. |
| **Google Cloud** | Open — documented by Google | $0 while $300 trial credit lasts | **Best option if you have trial credit.** See §11.3. |
| **AWS / Azure free tiers** | 587 open | Not actually free — see below | Not worth the complexity. |

**The free cloud tiers are a trap for this project.** Oracle's is genuinely free but blocks the
one port we need. Google's "Always Free" e2-micro does allow 587, but the free tier covers the
*instance* and not its public IPv4 address — and since Feb 2024 an in-use external IP costs
about $0.005/hour, roughly **$3.65/month**. AWS and Azure added the same IPv4 charge. So the
"free" VM ends up costing more than RackNerd charges for a whole year.

### 11.2 Which to pick

**If you have Google Cloud $300 trial credit, use it — skip to §11.3.** It is free for 90
days, Google documents port 587 as unrestricted, and there is no surprise-billing risk.
The only catch is that the bot stops on day 90 unless you upgrade or migrate.

**Otherwise — RackNerd 1GB KVM, $21.99 for a full year** (~$1.83/month). Port 25 is open by
default, so 587 certainly is. 1GB RAM is ample — the bot idles around 80MB. US datacenters. They
accept PayPal, card, and crypto, so a card is not the only way in. You pay once and it's done.

The honest tradeoff: RackNerd is a budget host. Support is ticket-only and its reliability
reputation is good-not-great. For a bot whose value is being up at the right moment that
matters — so set up the `/healthz` monitor in §7, which tells you within minutes if it dies.

**Upgrade if you'd rather not think about it: Hetzner CX23 in Germany or Finland, ~€6/month.**
Port 587 being open is documented policy and the machine is genuinely solid.

**Hetzner bills hourly (rounded up to one hour), and deleting a server stops the bill.** So the
real financial risk of "what if it doesn't work" is about **one cent**, not a month: create the
server, run the TCP 587 check in §11.4, and if it somehow fails, delete the server immediately.
You are never committed to a month up front. Note that a server still bills while *stopped* —
only deletion ends the charge. Use a European
location — Hetzner doesn't sell the cheap CX/CAX lines in the US, and the US-only lines more
than doubled in June 2026. The ~100ms of extra latency is irrelevant against a 10-second poll
interval.

> **Note:** this project needs *some* payment method no matter which host you choose, because
> the X API itself requires a **$5 minimum prepaid credit purchase** (§1). There is no version
> of this bot that runs on zero spend.

### 11.3 If you have Google Cloud $300 trial credit, use that

This is the best option available to you, for three reasons:

1. **Google documents port 587 as unrestricted.** Their own docs state: *"Google Cloud does not
   place any restrictions on traffic sent to external destination IP addresses using destination
   TCP ports 587 or 465."* Only port 25 is blocked, and we do not use it. That is a stronger
   guarantee than any other host gives.
2. **It costs $0 for 90 days** — the credit covers the VM, the disk and the public IP.
3. **There is no surprise-billing risk.** The free trial billing account *auto-closes* when the
   credit runs out or 90 days pass. Google will not charge you unless you manually click
   upgrade.

**The catch, and it is a real one: on day 90 the bot stops.** Your workloads are shut down when
the trial ends (recoverable for 30 days, then deleted). Put a calendar reminder at ~day 80 to
either upgrade or migrate to RackNerd. Migration is easy — copy `.env` and
`data/driversed.db` to the new box and re-run §3.

**What it costs if you do upgrade later:** put the VM in a free-tier region and pick `e2-micro`,
and the *instance* stays free forever under Always Free, as does the first 30GB of standard
disk. You would pay only for the external IPv4 address, about **$3.65/month**. More than
RackNerd's $21.99/year, but no upfront payment and a much better console.

#### Creating the VM

1. Go to **console.cloud.google.com** and activate the free trial. A card is required for
   identity verification; it is not charged.
2. Create a project called `drivers-ed` and select it.
3. Navigate to **Compute Engine → VM instances** and enable the API when prompted (takes a minute).
4. **Create instance**, and set:
   - **Name:** `drivers-ed`
   - **Region:** `us-east1` (South Carolina) — closest to you, and one of the three free-tier
     regions along with `us-west1` and `us-central1`. Using a free-tier region matters only if
     you later drop to Always Free, but it costs nothing to choose correctly now.
   - **Machine type:** series **E2** → **e2-micro**. Do not size up: e2-micro is the only
     Always-Free-eligible type, and the bot idles around 80MB of RAM.
   - **Boot disk:** Change → **Ubuntu 24.04 LTS**, disk type **Standard persistent disk**,
     size **30 GB** (the Always Free allowance).
   - **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**. This is essential —
     GCP blocks all inbound traffic by default, and without these two boxes Caddy cannot get a
     certificate and you cannot reach the dashboard.
5. **Create.**

#### Make the IP address static (do not skip this)

By default GCP gives the VM an *ephemeral* external IP that **changes whenever the VM restarts**,
which would silently break both DuckDNS and your HTTPS certificate.

Go to **VPC network → IP addresses**, find the address attached to `drivers-ed`, and change its
type from **Ephemeral** to **Static**. An attached static IP costs the same as an ephemeral one.

#### Connecting

Click the **SSH** button next to the instance in the console — it opens a browser terminal with
no SSH keys to manage.

**One important difference from the rest of this README:** that session logs you in as your own
user, not `root`. So either start with:

```bash
sudo -i
```

...and then follow §3 exactly as written, or prefix each §3 command with `sudo`.

#### First thing you run

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/smtp.gmail.com/587' && echo "587 OPEN — good" || echo "587 BLOCKED — stop"
```

It should say OPEN. Then continue with §3, and once the code is deployed run `npm run preflight`
(§2.1) on the server to confirm every integration works from there too.

### 11.4 Creating the RackNerd server, step by step

1. Go to **https://www.racknerd.com/specials** — NOT the main `/kvm-vps` pricing page. This
   matters a lot: the same 1GB machine is **$21.99/year** on the specials page and
   **$17.99/MONTH** on the standard page. One month of the standard plan costs about as much
   as a full year of the special.
2. Take the **1 GB KVM VPS — $21.99/year** (1 vCPU, 20GB SSD, 3TB transfer). Direct link:
   `https://my.racknerd.com/cart.php?a=add&pid=952`. Confirm the cart shows a *yearly* price
   before paying. Avoid any OpenVZ plans.
3. **Location:** pick a US East datacenter (New York or Ashburn) — closest to you and to Gmail.
4. **Operating system:** Ubuntu 24.04 (64-bit).
5. Pay with whichever method suits — card, PayPal, or crypto are all accepted.
6. Provisioning is usually minutes but can take a few hours on a new account. You'll get an
   email with the **IP address and root password**.
7. Connect: `ssh root@YOUR_SERVER_IP` and enter that password.
8. **Immediately change the root password**, since it was emailed to you in plain text:

```bash
passwd
```

9. Then add your SSH key so you can stop using the password entirely. On *your own* machine:

```bash
ssh-copy-id root@YOUR_SERVER_IP
```

10. **Before anything else, confirm port 587 actually works from the server:**

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/smtp.gmail.com/587' && echo "587 OPEN — good" || echo "587 BLOCKED — stop, this host will not work"
```

    If that says BLOCKED, stop and open a support ticket. Every later step will appear to
    succeed while the bot silently fails to send anything.

Then go to §3 and run the deployment.

### 11.5 The hostname — get it free

You do not need to buy a domain. This dashboard is a private page only you visit, so a
memorable name buys nothing. A **free DuckDNS subdomain gives you a real, browser-trusted
Let's Encrypt certificate** — identical security to a paid domain, $0/year.

1. Go to **duckdns.org** and sign in with GitHub or Google. No forms, no payment, no card.
2. Type a subdomain into the box — e.g. `jayden-lessons` — and click **add domain**.
3. Paste your server's IP into the **current ip** field and click **update ip**.
4. Wait a minute, then confirm it resolves from your own machine:

```bash
dig +short drivers-ed.duckdns.org
```

5. In `/etc/caddy/Caddyfile` (§3.6), put your hostname into Option A, then
   `systemctl reload caddy`. Caddy fetches the certificate within seconds.

**If you'd rather own a real domain:** Cloudflare Registrar is ~$10.44/yr at cost with zero
markup but locks you to their nameservers; Porkbun is ~$11.08/yr with no lock-in and free WHOIS
privacy. Avoid $1-first-year `.xyz` deals — the renewal usually exceeds a `.com`. With a real
domain, add one **A record** (`bot` → your server IP) and use Option B in the Caddyfile.

### 11.6 If you'd rather not rent a server at all

The bot is a single Node process with one SQLite file, so it runs fine on **hardware you
already own** — an old laptop left plugged in, or a Raspberry Pi. Home ISPs block port 25 but
not 587, so the claim email works. This is the only genuinely $0/month hosting option.

The differences from the VPS path: skip §3.1–3.2 (use the machine's existing user), and instead
of Caddy + DuckDNS, install **Tailscale** (free) on both the machine and your phone and reach
the dashboard over the private Tailscale address. That is simpler *and* safer than exposing it
to the internet, at the cost of only being reachable from your own devices.

The real risks are that home power cuts, router reboots, and laptop sleep settings all take the
bot offline silently — so the `/healthz` monitor matters even more here. Make sure the machine
is set to never sleep.

### 11.7 What this all costs

| | GCP trial (90 days) | RackNerd + DuckDNS | Hetzner + DuckDNS | Own hardware |
|---|---|---|---|---|
| Server | $0 (credit), then ~$3.65/mo for the IP | ~$1.83/mo ($21.99/yr) | ~$6.50/mo | $0 |
| Hostname + HTTPS | $0 | $0 | $0 | $0 (Tailscale) |
| X API reads | ~$0.45/mo, prepaid $5 minimum | same | same | same |
| Claude Haiku | under $1/mo | same | same | same |
| Gmail, ntfy | $0 | $0 | $0 | $0 |
| **Total** | **~$1.45/month** for 90 days | **~$3.30/month** | **~$8/month** | **~$1.50/month** |
