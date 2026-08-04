# Needham Driving School — Free Lesson Auto-Claim Bot

## 1. Goal

Monitor **@NeedhamDriving** on X for same-day "open lesson" posts. When a post matches
Jayden's criteria (area, date, time) and hasn't already been claimed, automatically email
`info@needhamdrivingschool.com` from `jaydenaleung@gmail.com` to claim it, then push a phone
notification the moment the email is confirmed sent. A password-protected dashboard lets
Jayden turn the bot on/off, set matching criteria, and see what happened (claimed,
attempted-but-skipped, errors).

Scope note: Threads monitoring was considered and dropped — X alone is the source, since the
school's posts to both platforms are usually the same lesson, and Threads had no reliable
official way to read a third-party account anyway. Revisit later only if X alone proves to
lose too many races.

---

## 2. Read this first — API realities that shape the design

**X (Twitter) API — no more free reads, but cheap at this volume.** Since February 2026, X is
pay-per-use: no free tier, reads billed at **$0.005 per post returned** (2M-read/month cap).
Billing is **per resource returned, not per request** — a poll using `since_id` that finds
nothing new returns zero resources and costs nothing. At an average of ~3 posts/day (~90/month),
that's roughly **$0.45/month** in read costs. Polling frequency itself is free; only actual new
posts cost anything.

**True real-time push from X is not realistically available.** X's official Filtered Stream
(webhook-style push) requires the **Pro tier at $5,000/month minimum**, or Enterprise pricing
above that — out of reach for a personal project. A **15–30 second polling loop** is the
practical near-real-time option. (A third-party relay like twitterapi.io offers sub-second
webhook push at ~$0.15/1,000 tweets and is worth adding later as a speed boost, but it's an
unofficial reseller of X data, not affiliated with X — treat it as a nice-to-have layered on
top of your own polling, not a replacement for it, since it could go down or get cut off
without warning.)

---

## 3. Architecture — single VPS, one process

Everything runs as one long-lived process on one small VPS (DigitalOcean/Hetzner, ~$5/mo,
smallest Ubuntu droplet). No split services, no separate hosting accounts — the same process
does the polling loop and serves the dashboard, and both read/write the same local SQLite
database file. Run it under `systemd` so it auto-restarts on crash or reboot; put Caddy in
front of it for automatic HTTPS.

```
One process (Node or Python), running under systemd on the VPS:

  Background loop (every 15–30s):
    check settings.script_enabled
    → poll X API with since_id (only returns genuinely new posts)
    → new post text → parser → {date, start_time, end_time, areas[], is_claim_notice}
    → match against lessons table (dedupe by date+start_time+area — the same lesson
      shouldn't be double-processed if it's posted more than once)
    → claim-notice posts flip matching open lessons to "claimed_by_school"
    → for lessons still "open": check against settings (enabled/area/time/date)
       → match: atomically flip status to "sending" BEFORE emailing (prevents double-send)
          → send claim email (Gmail SMTP, App Password)
          → on confirmed send: mark "email_sent", POST to ntfy.sh
       → no match: mark "skipped_*" with a specific reason
    → any failure at any step → write to errors table, keep looping

  Web server (same process):
    → password-gated dashboard
    → settings form (writes to the settings row)
    → claimed lessons list / attempted-but-skipped list with reasons / error feed
    → all reading the same local SQLite file, no separate API layer needed
```

Environment variables / secrets (in a `.env` file on the VPS, never committed to the repo):
- `X_BEARER_TOKEN`
- `X_ACCOUNT_USER_ID` (numeric ID for @NeedhamDriving)
- `GMAIL_ADDRESS` = jaydenaleung@gmail.com
- `GMAIL_APP_PASSWORD`
- `ANTHROPIC_API_KEY` (optional — see §5)
- `NTFY_TOPIC` (long, unguessable — ntfy topic names are effectively public)
- `DASHBOARD_PASSWORD`

---

## 4. Data model (SQLite)

**settings** (single row, editable from the dashboard)
- `script_enabled` (bool)
- `areas` (JSON array, subset of: Needham, Dedham, Dover, Natick, Wellesley, Weston, Westwood)
- `time_range_start`, `time_range_end`
- `date_range_start`, `date_range_end`
- `updated_at`

**posts_seen** (raw post log, for dedupe/debugging)
- `id`, `post_id`, `post_text`, `posted_at`, `fetched_at`

**lessons** (one row per distinct lesson the parser extracted — dedupe key is
date+start_time+area)
- `id`, `lesson_date`, `start_time`, `end_time`, `areas` (JSON array),
  `source_post_ids` (JSON array), `status` (`open` / `claimed_by_school` / `sending` /
  `email_sent` / `skipped_no_match` / `skipped_already_claimed` / `error`),
  `skip_reason` (nullable), `email_sent_at` (nullable)

**errors**
- `id`, `occurred_at`, `stage` (poll / parse / match / email / notify), `message`,
  `raw_context`

---

## 5. Post parsing & matching logic

Posts follow a loose template ("Lesson Open Today July 27th: 1-2 pm Needham/Wellesley Email
... to claim this hour.") but wording varies, so don't rely on regex alone.

**Recommended:** send raw post text to Claude Haiku with a strict instruction to return only
JSON:
```
{ "is_lesson_opening": bool, "is_claim_notice": bool, "date": "YYYY-MM-DD" | null,
  "start_time": "HH:MM" | null, "end_time": "HH:MM" | null, "areas": [string] | [] }
```
Fall back to a regex extractor (date words, "H-H pm", the seven town names) if the API call
fails, so a single API hiccup never silently drops a lesson. This adds well under $1/month
given ~90 posts/month.

**"Already claimed" detection:** a post is a claim-notice if it announces a specific date/time
as claimed, or a blanket claim ("All lessons have been claimed!" — treat as claiming every
currently-open lesson for that day). Flip matching `lessons` rows to `claimed_by_school`.

**Matching against criteria:** a lesson only gets an email if, at processing time,
`settings.script_enabled` is true AND at least one of the lesson's `areas` is in
`settings.areas` AND its time falls inside `settings.time_range` AND its date falls inside
`settings.date_range` AND its status is `open`. Log every skip with a specific reason (wrong
area / wrong time / wrong date / script off / already claimed / already emailed).

**Race safety:** confirm-and-flip the lesson's status to `sending` in one atomic
transaction before sending the email — never send two claim emails for the same lesson, even
if the same lesson somehow gets processed twice in quick succession.

---

## 6. Email claim flow

Template:
```
Subject: Claiming lesson – [Month Day], [Start]-[End] [Area]

Hi,

I'd like to claim the open lesson on [Month Day] from [Start]-[End] in [Area(s)].

Thanks,
Jayden Leung
```
Send via Gmail SMTP (smtp.gmail.com:587) with the App Password. Only after SMTP confirms
success, write `email_sent_at` and move to notification. On failure, log to `errors` and
leave status as `open` so the next loop cycle retries — don't silently drop a real opening
because of a transient SMTP error.

## 7. Phone notification

Immediately after confirmed send, `POST` to `https://ntfy.sh/<NTFY_TOPIC>` with the lesson
details. Failure here should never un-send the email or change `lessons.status` — log and
move on.

---

## 8. Dashboard

- Password gate (`DASHBOARD_PASSWORD`) — without this, anyone with the URL could toggle the
  bot off or see claim history.
- Settings panel: on/off; 7 area checkboxes (Needham, Dedham, Dover, Natick, Wellesley,
  Weston, Westwood); time-range picker; date-range picker.
- Claimed lessons list, attempted-but-not-claimed list (with skip reason), error feed.
- Nice-to-have: "last successful poll" timestamp, so you can tell at a glance if the loop has
  silently stopped.

---

## 9. Accounts / setup checklist

- [ ] VPS created (DigitalOcean or Hetzner, smallest Ubuntu droplet), SSH access ready
- [ ] X Developer account + app → bearer token, with a spending cap set in the X console
- [ ] 2-Step Verification enabled on jaydenaleung@gmail.com → Gmail App Password generated
- [ ] Anthropic API key (optional, for the Haiku parser)
- [ ] ntfy app installed on your phone, subscribed to a topic name you pick (unguessable)
- [ ] Dashboard password chosen
- [ ] Optional: domain name pointed at the VPS for a real HTTPS URL
- [ ] Optional, later: healthchecks.io free "dead man's switch," pinged on every successful
      poll, so you're alerted by email if the loop silently dies

---

## 10. Cost summary

| Item | Est. cost/month |
|---|---|
| VPS (smallest droplet) | $4–6 |
| X API reads (~90/month via since_id) | ~$0.45 |
| Claude Haiku parsing (~90 calls/month) | < $1 |
| Gmail SMTP, ntfy.sh | $0 |
| Domain (optional) | ~$1 amortized, or $0 |
| **Total** | **roughly $5–8/month**, almost entirely the VPS |

---

## 11. Testing plan

1. Unit-test the parser against the two example post formats plus hand-written variants.
2. Point the poller at a test X account you control, post fake "lesson open" / "claimed"
   messages, confirm the whole pipeline before pointing it at the real account.
3. Verify the email actually lands (check spam) and ntfy delivers within a few seconds.
4. Deliberately misconfigure settings (e.g. area not selected) and confirm the lesson shows
   up in "attempted but not claimed" with the right reason.
5. Force an error (bad token) and confirm it surfaces in the dashboard's error feed instead
   of crashing the process.
6. Kill the process and confirm systemd restarts it automatically.

---

## 12. Known limitations

- The bot can confirm *an email was sent*; it cannot confirm the school assigned the lesson
  to Jayden specifically. "Claimed" in the dashboard means "we emailed in time."
- 15–30s polling is not truly instantaneous. If lessons still get claimed within seconds,
  the next step up is the twitterapi.io relay (§2) layered on top, not a replacement for
  this design.
- A single VPS is a single point of failure — if it goes down, the bot goes silent. The
  optional healthchecks.io ping (§9) is the cheap way to find out quickly if that happens.

---

## 13. Open decisions for Jayden before/while building

- Confirm the exact matching rule for time range: does the lesson's window need to fall
  *entirely* inside the selected range, or is *any overlap* good enough?
- Confirm "area" matching should be "lesson mentions any selected area" (e.g. a
  Needham/Wellesley post matches if either is selected) — this doc assumes yes.
- Decide whether to include the Haiku-based parser from the start or begin regex-only and
  add it later.
