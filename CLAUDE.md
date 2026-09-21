# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No build step, linter, or test suite — this is a small zero-dependency Node script pair.
Validation is done by running against the real ASP API and a real Telegram bot.

```bash
cp .env.example .env             # fill in IDNP, doc series/issue date, Telegram bot token + chat id
node --env-file=.env src/index.js     # run the periodic checker once (npm run check)
node --env-file=.env src/respond.js   # run the on-demand command responder once
```

Node ≥20.6 is required (`--env-file` and native `fetch` are used directly; there is no
`npm install` step — `package.json` has no `dependencies`).

## Architecture

Two independent entrypoints, both plain HTTP clients against ASP's public JSON API,
sharing the same config/format/telegram modules, each running on its own GitHub Actions
schedule and persisting its own state file back into the repo (runners are ephemeral).

- **`src/index.js`** — periodic checker, run every 2h by `.github/workflows/check.yml`.
  Fetches all monitored targets, diffs against `state/slots.json`, and sends a Telegram
  alert only when something notification-worthy changed, plus one full summary per day
  (heartbeat, gated on local hour ≥ 8 in Europe/Chisinau).
- **`src/respond.js`** — on-demand command responder, run every 5 min by
  `.github/workflows/respond.yml`. Polls Telegram `getUpdates`, and if the configured
  chat sent a recognized command (`/acum`, `/live`, `/status`, `/check`), does a fresh
  live fetch (bypassing state entirely) and replies immediately. Tracks its own offset
  in `state/telegram.json` — a separate file from `slots.json` so the two workflows
  never write-conflict on the same file.
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
  (change here if a different transmission/category needs monitoring). Also validates
  required env vars at startup.
- **`src/state.js`** — persistence + diff logic for the periodic checker. Tracks, per
  category, the *earliest known available date* (not just a raw list of slots), and
  only fires a priority alert when that minimum gets earlier — that's the actual signal
  the monitor exists for. A category's first-ever read is a silent baseline (tracked via
  `state.initialized`) so day one doesn't fire a "record" alert for every category at
  once.
- **`src/format.js`** — all Telegram message construction, MarkdownV2 escaping, and
  date/timezone utilities (fixed to Europe/Chisinau regardless of runner locale). Groups
  the "obișnuit" and "urgent" variants of the same exam+location for display (they
  empirically always share identical dates), but verifies equality per-message rather
  than assuming it, falling back to showing both separately if they ever diverge.
  Renders the multi-location practic comparison as a fixed-width table inside a
  ` ``` ` code block, since Telegram does not render Markdown tables — only monospaced
  code blocks preserve column alignment.
- **`src/telegram.js`** — minimal Telegram Bot API client (`sendMessage`, `getUpdates`).

### Two workflows, one repo, separate state files

`check.yml` (every 2h) and `respond.yml` (every 5 min) can run concurrently and both
commit state back to the same branch. Each writes only to its own file (`slots.json` vs
`telegram.json`) and each runs `git pull --rebase` before committing, so the two never
clobber each other's commit.

### Alert classification (see comments in `state.js`)

A new date is one of three things, each handled differently:
1. It makes the category's earliest date *earlier* → priority alert (🔥), the main signal.
2. It's new but later than the current earliest → normal alert, listed separately.
3. A previously-seen date disappears → no alert, only reflected in the next heartbeat.

This is intentional, not an oversight — this project is about surfacing "you can book
sooner than before", not raw diffing of every open/close event.
