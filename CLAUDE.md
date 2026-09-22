# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No build step, linter, or test suite — this is a small zero-dependency Node script pair.
Validation is done by running against the real ASP API and a real Telegram bot.

```bash
cp .env.example .env             # fill in IDNP, doc series/issue date, Telegram bot token + chat id
node --env-file=.env src/index.js     # run the periodic checker once (npm run check)
```

Node ≥20.6 is required (`--env-file` and native `fetch` are used directly; there is no
`npm install` step — `package.json` has no `dependencies`).

The webhook function (`api/telegram-webhook.js`) can't be run locally the same way — it's
a Vercel serverless function. Test it by curling the deployed URL directly (see README's
webhook section), or by unit-testing `src/live.js`'s `buildLiveReply` in isolation.

## Architecture

Two independent pieces, both plain HTTP clients against ASP's public JSON API, sharing the
same `config`/`asp`/`format`/`telegram` modules, deployed to two different platforms
because they have fundamentally different latency requirements.

- **`src/index.js`** — periodic checker, run every 2h by `.github/workflows/check.yml`
  on GitHub Actions. Fetches all monitored targets, diffs against `state/slots.json`
  (committed back to the repo each run, since the runner is ephemeral), and sends a
  Telegram alert only when something notification-worthy changed, plus one full summary
  per day (heartbeat, gated on local hour ≥ 8 in Europe/Chisinau).
- **`api/telegram-webhook.js`** — on-demand command responder, deployed as a Vercel
  serverless function and registered with Telegram via `setWebhook`. When the configured
  chat sends a recognized command (`/acum`, `/live`, `/status`, `/check`), Telegram POSTs
  the update directly here — no polling, no state, response in ~1-2s. Verifies the
  `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` before doing
  anything (the endpoint is public by nature; this is the only thing stopping a stranger
  who finds the URL from triggering a live fetch). Deployed as a separate Vercel project
  (`asp-programare-webhook`) with its own copy of the same env vars — **not wired to
  auto-deploy from git**, so a code change here needs a manual redeploy.
  (An earlier version polled Telegram's `getUpdates` every 5 min via a second GitHub
  Actions workflow — replaced because polling has a hard ~5 min floor and no reasonable
  way to go lower on that platform. The webhook has none of that latency.)
- **`src/live.js`** — the actual "fetch everything live + build the reply" logic, shared
  between the webhook and (if ever needed) a local script. Deliberately has no dependency
  on `state.js` — a live check bypasses the diff/history entirely by design.
- **`src/asp.js`** — the only module that talks to `eservicii.gov.md/asp/dimtcca/api`.
  No browser/Playwright is used; it's a 3-step JSON chain per target: `get-service`
  (resolve a service ID from exam type + urgency [+ vehicle category for practic]) →
  `qmatic/locations` (resolve a location ID from its display name) → `qmatic/dates`
  (POST, returns available days ± ~3 months, with slot counts). Includes retry with
  backoff and strict response-shape validation — an unexpected/malformed response is
  treated as a failure, never silently as "no slots available".
- **`src/config.js`** — defines `CATEGORIES`, the flattened list of (exam type ×
  urgency × location) targets actually monitored, built from `BASE_CATEGORIES` ×
  `LOCATIONS`. The theoretical exam has a single Chișinău location (Salcâmilor); the
  practical exam has three (Rădăuțanu, Ieșilor, Salcâmilor), each needing an explicit
  `servicePath` segment for the vehicle category — currently hardcoded to `BMechanical`
  (an automatic-transmission variant, `BAutomatic`, also exists and was verified live if
  that's ever needed instead). Also validates required env vars at startup.
  **Urgency is a separate exam-type name, not a boolean flag**: the real ASP site (captured
  22.09.2026 from the actual APO01 request flow's network calls) resolves urgent via
  `get-service/TheoreticalUrgentExam/False` / `PracticalUrgentExam/False/{categorie}` — a
  distinct `get-service` path, always with `False` as the second segment. An earlier version
  used `TheoreticalExam/True` / `PracticalExam/True/{categorie}` (urgency as `True` on the
  *same* exam type); that also returns 200 with a valid-looking service ID, but it's the
  wrong service — a silent failure that happened to mirror obișnuit's calendar. Confirmed
  live via the site's own "calendar informativ" widget (visible mid-flow before payment,
  network-tab-captured) that real urgent dates are genuinely earlier than obișnuit's.
- **`src/state.js`** — persistence + diff logic, used only by the periodic checker (the
  webhook never touches this). Tracks, per category, the *earliest known available date*
  (not just a raw list of slots), and only fires a priority alert when that minimum gets
  earlier — that's the actual signal the monitor exists for. A category's first-ever read
  is a silent baseline (tracked via `state.initialized`) so day one doesn't fire a
  "record" alert for every category at once.
- **`src/format.js`** — all Telegram message construction, MarkdownV2 escaping, and
  date/timezone utilities (fixed to Europe/Chisinau regardless of runner locale). Always
  shows "obișnuit" and "urgent" as separate labeled lines — a deliberate user choice, not
  an oversight to "fix" by collapsing them. They usually do diverge in practice (urgent is
  often earlier — see the `config.js` note on the `servicePath` bug this used to mask);
  `liveGroupLines` in `format.js` renders a compact single-date block when they coincide
  and an explicit `obișnuit: … · urgent: …` comparison line when they don't, so both cases
  render correctly without assuming either. Renders the multi-location practic comparison
  as a fixed-width table inside a ` ``` ` code block, since Telegram does not render
  Markdown tables — only monospaced code blocks preserve column alignment.
- **`src/telegram.js`** — minimal Telegram Bot API client (`sendMessage`; also
  `getUpdates`, unused now that the responder is webhook-based, kept in case a polling
  fallback is ever needed again).

### Why MarkdownV2 escaping is centralized and non-negotiable

`escapeMarkdownV2` must be applied to every piece of dynamic text (dates, error messages,
location names — several contain `.` and `(` `)`), but never to the literal `*`/`_`/code
fence markup characters that provide bold/italic/monospace. The pattern used throughout
`format.js` is: escape each text fragment individually, then wrap the *already-escaped*
result in markup characters — never escape a string that already contains markup, or the
markup itself gets escaped into literal text and Telegram either renders it wrong or
rejects the message outright with a 400.

### Alert classification (see comments in `state.js`)

A new date is one of three things, each handled differently:
1. It makes the category's earliest date *earlier* → priority alert (🔥), the main signal.
2. It's new but later than the current earliest → normal alert, listed separately.
3. A previously-seen date disappears → no alert, only reflected in the next heartbeat.

This is intentional, not an oversight — this project is about surfacing "you can book
sooner than before", not raw diffing of every open/close event.
