# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

No build step, linter, or test suite. Validation is done by running against the real ASP
API and a real Telegram bot.

```bash
cp .env.example .env             # fill in IDNP, doc series/issue date, Telegram bot token + chat id
node --env-file=.env src/index.js     # run the periodic checker once (npm run check)
```

Node ≥20.6 is required (`--env-file` and native `fetch` are used directly). The periodic
checker (`src/index.js`) is still zero-dependency — no `npm install` needed to run it.
`redis` is the project's one real dependency, added only for the webhook's
`src/userStore.js` (letting other people use the bot); `index.js` never imports it.

The webhook function (`api/telegram-webhook.js`) can't be run locally the same way — it's
a Vercel serverless function. Test it by curling the deployed URL directly (see README's
webhook section), or by unit-testing `src/live.js`'s `buildLiveReply` in isolation.

## Architecture

Two independent pieces, both plain HTTP clients against ASP's public JSON API, sharing the
same `config`/`asp`/`format`/`telegram` modules, deployed to two different platforms
because they have fundamentally different latency requirements.

- **`src/index.js`** — periodic checker, run hourly (`30 * * * *`) by
  `.github/workflows/check.yml` on GitHub Actions (`schedule` is best-effort — gaps of
  hours happen; accepted). Fetches all monitored targets, diffs against `state/slots.json`
  (committed back to the repo each run, since the runner is ephemeral), and sends a
  Telegram alert only when something notification-worthy changed, plus one full summary
  per day (heartbeat, gated on local time ≥ 7:30 in Europe/Chisinau). The workflow's
  "Commit state" step runs with `if: always()` — the check step exits 1 when every
  category fails, and without `always()` the state (failure streak, rate-limit block)
  would never be saved, so the failure alert could never fire.
  **ASP rate limit (verified live 24.09.2026): a daily quota per IDNP, not per IP, reset
  at 00:00 UTC** — same IP with a different IDNP answers normally; the blocked IDNP gets
  HTTP 429 with `Retry-After` up to 23:59:59 UTC. Roughly 250–300 `dates` requests/day
  (estimate — `state.aspDaily`, logged on every "OK —" line, exists to replace the guess
  with data). `asp.js` therefore throws `RateLimitError` on 429 instead of retrying (a
  retry only burns quota that's already gone); `index.js` treats it as a circuit breaker:
  stop the category loop at the first 429, persist `state.rateLimitedUntil`, notify once
  (`buildRateLimitMessage`), and make **zero** ASP requests until that time. A limited run
  exits 0 and leaves `consecutiveFailures` untouched — a 429 says nothing about the site's
  structure, unlike the "all categories failed" case the streak/alert exists for.
- **`api/telegram-webhook.js`** — on-demand command responder, deployed as a Vercel
  serverless function and registered with Telegram via `setWebhook`. When the configured
  chat sends a recognized command (`/acum`, `/live`, `/status`, `/check`, `/help`, plus
  `/inregistrare`/`/start`/`/sterge` for non-owner chats — see below), Telegram POSTs
  the update directly here — no polling, no state, response in ~1-2s. `/help` is checked
  **before** the pending-registration check in the non-owner branch — it's the escape
  hatch out of confusion, so it has to work even mid-registration, not get swallowed by
  step validation. Verifies the
  `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (constant-time
  compare via `crypto.timingSafeEqual`, not `!==`) before doing anything (the endpoint is
  public by nature; this is the only thing stopping a stranger who finds the URL from
  triggering a live fetch). Deployed as a separate Vercel project
  (`asp-programare-webhook`) with its own copy of the same env vars — **not wired to
  auto-deploy from git**, so a code change here needs a manual redeploy.
  (An earlier version polled Telegram's `getUpdates` every 5 min via a second GitHub
  Actions workflow — replaced because polling has a hard ~5 min floor and no reasonable
  way to go lower on that platform. The webhook has none of that latency.)
  **Post-audit hardening (added after a security review found the bot let anyone
  register their own government ID with zero gatekeeping):** any chat that isn't the
  owner and isn't already `approved` in `access:<chatId>` (Redis, see `userStore.js`)
  gets a "cerere trimisă" reply instead of being asked for IDNP straight away; the owner
  is notified once (first message only, via `SET NX` in `requestAccessIfNew`) with an
  inline ✅ Aprobă / ❌ Respinge keyboard. Decisions arrive as `callback_query` updates
  (handled in `handleCallbackQuery`, separate from `message` updates in the same
  handler) — trusted only when `callback_query.from.id` matches the owner's configured
  chat ID, never the `callback_data` payload alone. `/utilizatori` (list approved chats)
  and `/revoca <chat_id>` (wipe access + person + pending state for one chat) are
  owner-only commands for managing this. The bot also `leaveChat`s itself out of any
  non-private chat immediately — it's designed for 1:1 use only, since a group would let
  anyone in it read whatever another member typed (including IDNP/serie/date during
  registration) and drive `/acum`/`/sterge` on someone else's saved data.
- **`src/live.js`** — the actual "fetch everything live + build the reply" logic, shared
  between the webhook and (if ever needed) a local script. Deliberately has no dependency
  on `state.js` — a live check bypasses the diff/history entirely by design. Unlike
  `index.js` (sequential, no time pressure), this fetches all `CATEGORIES` **in
  parallel** with a shorter retry/timeout budget (`FAST_FETCH_OPTIONS`) and a per-call
  memoization `Map` passed into `fetchCategoryDates` — required to fit inside Vercel's
  `maxDuration: 30` on `api/telegram-webhook.js` (8 categories run sequentially with the
  cron's slower retry policy would blow past that). A `RateLimitError` from any category
  (ASP's per-IDNP daily quota, see `src/index.js` above) is returned as
  `rateLimitedUntil`, and if nothing at all could be read the reply is the dedicated
  `buildAspBlockedMessage` ("try again after HH:MM") instead of a vague "8/8 unreadable".
  The webhook's `liveReplyText` persists that via `userStore.setAspBlock` and checks
  `getAspBlock` *before* fetching, so later `/acum`s for the same IDNP cost zero ASP
  requests until the quota resets (Redis is best-effort there — if it's down, the live
  check still runs, just without the memory of the block).
- **`src/asp.js`** — the only module that talks to `eservicii.gov.md/asp/dimtcca/api`.
  No browser/Playwright is used; it's a 3-step JSON chain per target: `get-service`
  (resolve a service ID from exam type + urgency [+ vehicle category for practic]) →
  `qmatic/locations` (resolve a location ID from its display name) → `qmatic/dates`
  (POST, returns available days ± ~3 months, with slot counts). Includes retry with
  backoff (`fetchWithRetry` takes an optional `{ retryDelays, timeoutMs }` — omitted for
  `index.js`, so the cron path's behavior is unchanged; `live.js` overrides both to stay
  fast) and a per-request `AbortSignal.timeout` on every attempt (a hung fetch used to be
  able to block a request indefinitely). `getServiceId`/`getLocations` take an optional
  `cache` `Map` that memoizes the in-flight *promise* (not just the resolved value) keyed
  by service path / service ID — only 4 distinct service paths exist across the 8
  monitored categories, so without it `live.js`'s parallel fetch would redundantly
  request the same service ID / location list multiple times. HTTP 429 is **not**
  retried: `fetchWithRetry` throws `RateLimitError` (with `until`, parsed from
  `Retry-After`; fallback next 00:00 UTC) immediately — see the rate-limit note under
  `src/index.js`. Strict response-shape validation throughout — an unexpected/malformed
  response is treated as a failure, never silently as "no slots available".
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
  often earlier — see the `config.js` note on the `servicePath` bug this used to mask).
  **`liveGroupLines`** (the `/acum` reply) renders every `obișnuit`/`urgent` line with the
  exact same shape — `eticheta: **dată** · peste N zile · X locuri` (or "fără zile
  libere") — regardless of whether the two dates coincide, diverge, or one of them has no
  free days at all; location (practic only) is always its own bold header line above,
  never inlined into a date line. An earlier version collapsed the two variants onto one
  shared line when their dates matched, showed a bare date-only comparison line with no
  days-until/slots when they diverged, and silently dropped a variant entirely when it had
  zero free dates — three different shapes for what's conceptually the same information,
  flagged as inconsistent after the security audit and rewritten to always use the one
  shape. Renders the multi-location practic comparison as a fixed-width table inside a
  ` ``` ` code block (in the heartbeat/summary message, via the separate
  `buildClosestDatesLines`/`closestLinesForGroup` path — unaffected by the `/acum`
  rewrite above), since Telegram does not render Markdown tables — only monospaced code
  blocks preserve column alignment.
- **`src/telegram.js`** — minimal Telegram Bot API client built on one generic
  `callTelegram(botToken, method, payload)` helper (POSTs to
  `api.telegram.org/bot<token>/<method>`, throws on a non-2xx or `{ok: false}`).
  `sendMessage`/`getUpdates`/`setMyCommands` are built on it, plus
  `answerCallbackQuery` (must be called on every inline-button press or Telegram shows a
  stuck "loading" spinner on the button), `editMessageText` (marks the access-request
  message as decided, in place), `deleteMessage` (removes a user's message containing
  IDNP/serie/date right after the bot reads it) and `leaveChat` (see the group-chat note
  under `api/telegram-webhook.js`). `getUpdates` is unused now that the responder is
  webhook-based, kept in case a polling fallback is ever needed again. Also exports three
  persistent reply-keyboards (`ACUM_KEYBOARD`, `REGISTERED_KEYBOARD`, `REGISTER_KEYBOARD`),
  each showing only the commands that actually apply to that chat's state, plus `/help`
  on all three — `sendTelegramMessage` defaults to `ACUM_KEYBOARD` so `index.js`'s calls
  (owner only) need no changes; the webhook passes the other two, or an inline
  approve/deny keyboard, explicitly depending on chat state. `sendTelegramMessage`
  returns the last sent message (needed to capture the access-request notification's
  `message_id`, later passed to `editMessageText` once the owner decides).
- **`src/registration.js`** + **`src/userStore.js`** — let people other than the bot's
  owner use it too, *in their own name* (own IDNP/doc series/issue date), not the
  owner's, but **only once the owner has approved that chat** (see
  `api/telegram-webhook.js` above) — an unrestricted version of this flow is exactly what
  a security audit flagged: anyone finding the bot could register a government ID with no
  gatekeeping at all. Only the webhook touches these — `index.js` (periodic checker)
  still only ever runs as the owner, from `.env`, unchanged. `registration.js` is the
  pure state machine: IDNP (validated as 13 digits *and* checked against Moldova's real
  checksum — weights 7/3/1 repeated over the first 12 digits, mod 10 must equal digit
  13 — to catch typos before they ever reach ASP) → seria → data eliberării, each
  validated and re-prompted on bad input. Any step's raw input starting with `/` is
  treated as "user typed a command instead of answering" and cancels registration with a
  clear message (`{ cancelled: true }`) instead of being validated as a nonsense IDNP —
  the pre-audit version would confusingly reject `/acum` typed mid-registration as
  "IDNP invalid". Also exports `buildHelpMessage` (adapts its command list to owner /
  already-registered / needs-to-register / needs-approval) and the access-request
  message builders (`formatAccessRequestText`, `buildAccessDecisionLine`,
  `buildAccessDecisionMessage`, plus the `ACCESS_*` reply constants) used by the
  approval flow. `userStore.js` persists everything in Redis (via the `redis` npm
  client — the one dependency the project has, used only by the webhook; `index.js`'s
  zero-dependency checker never imports this module), with the connection configured
  with a 5s connect timeout and a bounded reconnect strategy (gives up after 3 tries
  instead of hanging a request indefinitely), and resets its cached connection promise
  on a failed `connect()` so the next request can retry instead of being stuck replaying
  the same rejected promise until the instance recycles. Three record types, all with
  TTLs so stray personal data doesn't accumulate forever: `person:<chatId>` (90 days),
  `pending:<chatId>` (10 minutes — an abandoned mid-registration chat doesn't stay
  wedged), `access:<chatId>` (30 days while pending/denied, 90 while approved).
  **Every value written through `setJSON`/`getJSON` is encrypted AES-256-GCM** with
  `USER_DATA_KEY` (32 random bytes, base64, kept separate from `REDIS_URL`) before it
  touches Redis — this stores real government ID numbers belonging to people who are not
  the project's owner, so a leaked/misconfigured Redis connection string alone must not
  be enough to read them. A record that fails to decrypt (wrong key, corruption, or the
  pre-encryption plaintext format from before this was added) is treated as if it didn't
  exist, not as a fatal error. The ASP daily-quota block (`getAspBlock`/`setAspBlock`) is
  keyed `asp:blocked:<sha256(idnp)>` — hashed because Redis keys aren't encrypted and an
  IDNP is personal data — with a TTL equal to the time left until the block ends, so it
  expires on its own. Per IDNP, so the owner and each guest are independent.
  Rate-limiting (`tryAcquireRateLimit`,
  `isGlobalRateLimited`) lives here too, as plain Redis counters (no personal data, so no
  encryption) — per-chat so one user's `/acum` doesn't put another user on cooldown (the
  original single shared in-memory cooldown did exactly that), plus a global per-minute
  cap to protect ASP's API from combined volume across every registered user. `/sterge`
  lets anyone erase their own stored data on demand.
- **`scripts/set-commands.mjs`** — one-off script (`npm run set-commands`) that registers
  the command list in Telegram's native "Menu" button next to the text field, with a
  reduced list scoped just to the owner's chat (no `/inregistrare`/`/sterge` — meaningless
  for someone whose data comes from `.env`, not Redis — but with `/utilizatori` and
  `/revoca`, meaningless for anyone else). Re-run only when the command list changes,
  not on every deploy.

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
