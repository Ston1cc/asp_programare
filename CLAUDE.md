# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
cp .env.example .env             # fill in IDNP, doc series/issue date, Telegram bot token + chat id
node --env-file=.env src/index.js     # run the local checker once (npm run check)
npm test                          # node --test -- no build step, this is the whole test setup
```

Node ≥22 is required (`--env-file`, native `fetch`, `node --test` are used directly).
`src/index.js` is still zero-dependency — no `npm install` needed to run it. `redis` is the
project's one real dependency, needed by both Vercel functions (`api/telegram-webhook.js`
for the guest-registration flow, `api/cron-check.js` unconditionally for state/locking) via
`src/userStore.js`; `src/index.js` (the local runner) never imports it.

Neither Vercel function can be run locally the same way — test `api/telegram-webhook.js` by
curling the deployed URL directly (see README's webhook section), or by unit-testing
`src/live.js`'s `buildLiveReply` in isolation; test `api/cron-check.js` similarly by curling
it with the `CRON_SECRET` header once deployed. `npm test` covers the pure logic
(`src/check.js`, `src/prefs.js`, `src/state.js`, `src/format.js`, `src/registration.js`,
`src/config.js`) without touching ASP, Telegram, or Redis.

## Architecture

Two independent responders, both plain HTTP clients against ASP's public JSON API,
sharing the same `config`/`asp`/`format`/`telegram`/`prefs` modules, both deployed as
Vercel serverless functions because they have fundamentally different latency
requirements — but each triggered externally rather than by Vercel's own scheduler:

- **`api/cron-check.js`** — the periodic checker, triggered every ~10 minutes by an
  **external cron** (cron-job.org, not Vercel Cron — see below). Fetches all monitored
  targets, diffs against Redis-backed state (via `src/check.js`'s `runCheck`), and sends a
  Telegram alert only when something notification-worthy changed, plus one full summary
  per day (heartbeat, gated on local hour ≥ 7:30 in Europe/Chisinau). Authenticates via
  `Authorization: Bearer <CRON_SECRET>` (constant-time compare, `src/secret.js`, shared
  with the webhook) and takes a Redis lock (`checker:lock`, 110s TTL) against overlapping
  cron calls.
  (Originally ran as `src/index.js` on GitHub Actions every 30 min via `schedule`, with
  state committed back to the repo each run. Replaced because GH Actions' `schedule` is
  only best-effort — state-commit timestamps across 21–23.09.2026 showed runs landing
  3–9h apart, sometimes far past the nominal cadence, which delays the one signal this
  whole project exists to deliver fast. **Not Vercel Cron either** — on the Hobby plan
  Vercel Cron jobs run at most once a day, useless here.)
- **`api/telegram-webhook.js`** — on-demand command responder. When the configured chat
  sends a recognized command (`/acum`, `/live`, `/status`, `/check`, `/setari`, `/help`,
  plus `/inregistrare`/`/start`/`/sterge` for non-owner chats — see below), Telegram POSTs
  the update directly here — no polling, no state, response in ~1-2s. `/help` is checked
  **before** the pending-registration check in the non-owner branch — it's the escape
  hatch out of confusion, so it has to work even mid-registration, not get swallowed by
  step validation. Verifies the
  `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (constant-time
  compare via `src/secret.js`, not `!==`) before doing anything (the endpoint is
  public by nature; this is the only thing stopping a stranger who finds the URL from
  triggering a live fetch). Deployed as a separate Vercel project
  (`asp-programare-webhook`) with its own copy of the same env vars, **now wired to
  auto-deploy from git** (see README) — a code change here no longer needs a manual
  redeploy.
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
  **`/setari`'s inline callback routing (`pref:<path>`) is deliberately NOT owner-gated**
  like `approve:`/`deny:` are — any approved chat can toggle its own preferences. This is
  safe because a `pref:` callback never carries a target chat id in its payload at all
  (unlike `approve:<chatId>`) — the action always applies to `cq.from.id`, the identity
  Telegram itself confirms, so one guest pressing a button can never touch another
  chat's preferences.
- **`src/check.js`** — the fetch/diff/heartbeat core, shared between `api/cron-check.js`
  (Redis-backed store) and `src/index.js` (file-backed store, see below) so the two never
  duplicate logic. `runCheck({ config, store, categories, prefs, fetchDates, ... })`
  fetches all `categories` (default: every monitored target) **in parallel** (unlike the
  old sequential loop) with a per-run cache `Map`, builds `{ text, keyboard? }` messages
  (only the earlierDays/newLaterDays alert gets `BOOKING_KEYBOARD`), and returns the next
  state for the caller to persist. `prefs` (optional, `src/prefs.js`) filters ONLY what
  appears in the alert/heartbeat text — every category is always fetched and diffed
  regardless of prefs, so re-enabling a category from `/setari` never looks like a false
  "record" against a stale diff baseline. `fetchDates` is injectable, used by
  `test/check.test.js` to avoid hitting ASP live.
- **`src/index.js`** — thin local runner on top of `runCheck`, using `state.js`'s
  file-based store (`state/slots.json`, **gitignored**, not committed by CI anymore — the
  Vercel checker's Redis state is the real source of truth). No longer wired to any
  schedule; kept for manual runs or a local Task Scheduler job, e.g. if ASP ever blocks
  Vercel's IPs.
- **`src/live.js`** — the actual "fetch everything live + build the reply" logic, shared
  between the webhook's `/acum` and (if ever needed) a local script. Deliberately has no
  dependency on `state.js` — a live check bypasses the diff/history entirely by design.
  Unlike the periodic checker (no time pressure), this fetches all categories **in
  parallel** with a shorter retry/timeout budget (`FAST_FETCH_OPTIONS`) and a per-call
  memoization `Map` passed into `fetchCategoryDates` — required to fit inside Vercel's
  `maxDuration: 30` on `api/telegram-webhook.js`. `buildLiveReply(person, { now,
  categories, targetDate })` takes an optional pre-filtered `categories` list (from
  `src/prefs.js`'s `selectCategories`) and an optional `targetDate` (marks ✅ on dates
  that meet it, from `/setari`'s "Până la"); with neither, it defaults to every category
  for `person.vehicle` (or `BMechanical` if unset).
- **`src/asp.js`** — the only module that talks to `eservicii.gov.md/asp/dimtcca/api`.
  No browser/Playwright is used; it's a 3-step JSON chain per target: `get-service`
  (resolve a service ID from exam type + urgency [+ vehicle category for practic]) →
  `qmatic/locations` (resolve a location ID from its display name) → `qmatic/dates`
  (POST, returns available days ± ~3 months, with slot counts). Includes retry with
  backoff (`fetchWithRetry` takes an optional `{ retryDelays, timeoutMs }` — omitted for
  `index.js`, so the local runner's behavior is unchanged; `live.js`/`cron-check.js`
  override both to stay fast/within `maxDuration`) and a per-request `AbortSignal.timeout`
  on every attempt (a hung fetch used to be able to block a request indefinitely). Strict
  response-shape validation throughout — an unexpected/malformed response is treated as a
  failure, never silently as "no slots available".
- **`src/config.js`** — defines `BASE_CATEGORIES` (exam type × urgency, minus the vehicle
  segment for practic) and `buildCategories(vehicle = 'BMechanical')`, which expands that
  ×`LOCATIONS` and appends the vehicle segment to practic's `servicePath`. `CATEGORIES =
  buildCategories()` is the BMechanical default every non-vehicle-aware caller uses
  (owner, local runner, cron-check.js). Practic category **keys** get a vehicle suffix
  (e.g. `practic-obisnuit-radautanu-bautomatic`) when vehicle ≠ the default — otherwise a
  BMechanical and BAutomatic category for the same location would collide in
  `state.js`'s `earliest`/`slots` (indexed by `categoryKey`), mixing the diff history of
  two users who chose different vehicles. Also defines `HORIZON_DAYS` (90 — how far ahead
  `filterWithinHorizon` in `format.js` keeps dates; ASP returns roughly that much) and
  `BOOKING_URL` (the ASP portal root — it's a Blazor SPA with no deep link into the
  booking flow, so this is a landing point, not a direct link to the form). The theoretical
  exam has a single Chișinău location (Salcâmilor); the practical exam has three
  (Rădăuțanu, Ieșilor, Salcâmilor), each needing an explicit `servicePath` segment for the
  vehicle category.
  **Urgency is a separate exam-type name, not a boolean flag**: the real ASP site (captured
  22.09.2026 from the actual APO01 request flow's network calls) resolves urgent via
  `get-service/TheoreticalUrgentExam/False` / `PracticalUrgentExam/False/{categorie}` — a
  distinct `get-service` path, always with `False` as the second segment. An earlier version
  used `TheoreticalExam/True` / `PracticalExam/True/{categorie}` (urgency as `True` on the
  *same* exam type); that also returns 200 with a valid-looking service ID, but it's the
  wrong service — a silent failure that happened to mirror obișnuit's calendar. Confirmed
  live via the site's own "calendar informativ" widget (visible mid-flow before payment,
  network-tab-captured) that real urgent dates are genuinely earlier than obișnuit's.
- **`src/state.js`** — persistence + diff logic, used by both `src/check.js`-based
  runners via a `{ load, save }` store. Tracks, per category, the *earliest known
  available date* (not just a raw list of slots), and only fires a priority alert when
  that minimum gets earlier — that's the actual signal the monitor exists for. A
  category's first-ever read is a silent baseline (tracked via `state.initialized`) so
  day one doesn't fire a "record" alert for every category at once. Exports `EMPTY_STATE`
  (used by both the file store and the Redis store in `api/cron-check.js` to start from
  identical defaults) plus the file-specific `loadState`/`saveState` used only by
  `src/index.js`.
- **`src/format.js`** — all Telegram message construction, MarkdownV2 escaping, and
  date/timezone utilities (fixed to Europe/Chisinau regardless of runner locale).
  `filterWithinHorizon(dates, now, days = HORIZON_DAYS)` keeps dates in `[today,
  today+days]` (replaced an earlier `filterCurrentAndNextMonth`, which silently dropped
  real dates near the end of a month — a practic filiala whose first free day was in the
  next-next month would vanish from every message). `buildPracticTable` caps at 25 rows
  and returns `{ text, hiddenCount, lastShownDate }` — without the cap, the 90-day horizon
  could produce a table long enough for `splitMessage` to cut mid-\`\`\`-fence and break
  MarkdownV2. Always shows "obișnuit" and "urgent" as separate labeled lines — a
  deliberate user choice, not an oversight to "fix" by collapsing them. They usually do
  diverge in practice (urgent is often earlier — see the `config.js` note on the
  `servicePath` bug this used to mask).
  **`liveGroupLines`** (the `/acum` reply) renders every `obișnuit`/`urgent` line with the
  exact same shape — `eticheta: **dată** · peste N zile · X locuri` (or "fără zile
  libere") — regardless of whether the two dates coincide, diverge, or one of them has no
  free days at all; location (practic only) is always its own bold header line above,
  never inlined into a date line. Takes an optional `targetDate` (from `/setari`'s "Până
  la") and prefixes a matching line with ✅; `buildLiveNowMessage` adds a "🎯 Țintă" header
  line when one is set. Renders the multi-location practic comparison as a fixed-width
  table inside a ` ``` ` code block (in the heartbeat/summary message, via the separate
  `buildClosestDatesLines`/`closestLinesForGroup` path — unaffected by the `/acum` shape
  above), since Telegram does not render Markdown tables — only monospaced code blocks
  preserve column alignment.
- **`src/telegram.js`** — minimal Telegram Bot API client built on one generic
  `callTelegram(botToken, method, payload)` helper (POSTs to
  `api.telegram.org/bot<token>/<method>`, throws on a non-2xx or `{ok: false}`).
  `sendMessage`/`getUpdates`/`setMyCommands` are built on it, plus
  `answerCallbackQuery` (must be called on every inline-button press or Telegram shows a
  stuck "loading" spinner on the button), `editMessageText` (also takes an optional
  `replyMarkup`, used to update the `/setari` inline keyboard in place after a toggle;
  also marks the access-request message as decided), `deleteMessage` (removes a user's
  message containing IDNP/serie/date right after the bot reads it) and `leaveChat` (see
  the group-chat note under `api/telegram-webhook.js`). `getUpdates` is unused now that
  the responder is webhook-based, kept in case a polling fallback is ever needed again.
  Also exports four persistent reply-keyboards (`ACUM_KEYBOARD`, `REGISTERED_KEYBOARD`,
  `REGISTER_KEYBOARD`, `VEHICLE_KEYBOARD`) plus `BOOKING_KEYBOARD` (an inline keyboard
  with a "📝 Programează-te" button linking to `config.js`'s `BOOKING_URL`, attached to
  the periodic checker's earlierDays/newLaterDays alert and to every `/acum` reply — it's
  an inline keyboard, not a reply keyboard, specifically so it doesn't replace the
  persistent bottom keyboard: Telegram keeps that visible until a message explicitly sends
  another `ReplyKeyboardMarkup`). `sendTelegramMessage` defaults to `ACUM_KEYBOARD` so
  `src/index.js`'s calls (owner only) need no changes; the webhook passes the other
  keyboards, or an inline approve/deny keyboard, explicitly depending on chat state.
  `sendTelegramMessage` returns the last sent message (needed to capture the
  access-request notification's `message_id`, later passed to `editMessageText` once the
  owner decides).
- **`src/registration.js`** + **`src/userStore.js`** — let people other than the bot's
  owner use it too, *in their own name* (own IDNP/doc series/issue date, plus which
  vehicle transmission they're examined on), not the owner's, but **only once the owner
  has approved that chat** (see `api/telegram-webhook.js` above) — an unrestricted
  version of this flow is exactly what a security audit flagged: anyone finding the bot
  could register a government ID with no gatekeeping at all. Only the webhook touches
  these — `src/index.js`/`api/cron-check.js` (periodic checker, either variant) still
  only ever run as the owner, from `.env`, unchanged. `registration.js` is the pure state
  machine: IDNP (validated as 13 digits *and* checked against Moldova's real checksum —
  weights 7/3/1 repeated over the first 12 digits, mod 10 must equal digit 13 — to catch
  typos before they ever reach ASP) → seria → data eliberării → **vehicul** (manuală/
  automată — the 4th and final step, added because practic was previously hardcoded to
  BMechanical for everyone; accepts the `VEHICLE_KEYBOARD` buttons or typed shortcuts
  like `m`/`a`/`manuală`/`automată`), each validated and re-prompted on bad input. Any
  step's raw input starting with `/` is treated as "user typed a command instead of
  answering" and cancels registration with a clear message (`{ cancelled: true }`)
  instead of being validated as a nonsense IDNP — the pre-audit version would confusingly
  reject `/acum` typed mid-registration as "IDNP invalid". Also exports `buildHelpMessage`
  (adapts its command list to owner / already-registered / needs-to-register /
  needs-approval) and the access-request message builders (`formatAccessRequestText`,
  `buildAccessDecisionLine`, `buildAccessDecisionMessage`, plus the `ACCESS_*` reply
  constants) used by the approval flow. `userStore.js` persists everything in Redis (via
  the `redis` npm client — the project's one dependency, used by both Vercel functions;
  `src/index.js`'s zero-dependency local runner never imports this module), with the
  connection configured with a 5s connect timeout and a bounded reconnect strategy (gives
  up after 3 tries instead of hanging a request indefinitely), and resets its cached
  connection promise on a failed `connect()` so the next request can retry instead of
  being stuck replaying the same rejected promise until the instance recycles. Record
  types, all with TTLs where they hold personal data so stray government-ID data doesn't
  accumulate forever: `person:<chatId>` (90 days, **renewed by `touchUser` on every
  successful `/acum`** — without this, an active guest's data would expire 90 days after
  *registration* regardless of how often they actually used the bot, and they'd have to
  request access + re-register from scratch), `pending:<chatId>` (10 minutes — an
  abandoned mid-registration, or mid-"/setari Până la", chat doesn't stay wedged),
  `access:<chatId>` (30 days while pending/denied, 90 while approved, also renewed by
  `touchUser`). **Every value written through `setJSON`/`getJSON` is encrypted
  AES-256-GCM** with `USER_DATA_KEY` (32 random bytes, base64, kept separate from
  `REDIS_URL`) before it touches Redis — this stores real government ID numbers
  belonging to people who are not the project's owner, so a leaked/misconfigured Redis
  connection string alone must not be enough to read them. A record that fails to decrypt
  (wrong key, corruption, or the pre-encryption plaintext format from before this was
  added) is treated as if it didn't exist, not as a fatal error. Rate-limiting
  (`tryAcquireRateLimit`, `isGlobalRateLimited`), the periodic checker's Redis state
  (`getCheckerState`/`setCheckerState`, key `checker:state`) and overlap lock
  (`tryAcquireCheckerLock`/`releaseCheckerLock`, key `checker:lock`), and `/setari`
  preferences (`getPrefs`/`setPrefs`, key `prefs:<chatId>`) all live here too, **plain
  Redis values with no encryption and (except the lock's TTL) no expiry** — none of them
  are personal data, so the encryption/TTL rationale above doesn't apply: a leftover
  boolean-toggle record for an abandoned chat is harmless, and `checker:state` is meant
  to persist forever (it's what replaced the committed `state/slots.json`). Rate limits
  are per-chat so one user's `/acum` doesn't put another user on cooldown (the original
  single shared in-memory cooldown did exactly that), plus a global per-minute cap to
  protect ASP's API from combined volume across every registered user. `/sterge` lets
  anyone erase their own stored data on demand.
- **`src/prefs.js`** — the `/setari` filters: per-chat booleans (teoretic/practic/
  obișnuit/urgent/per-location) plus an optional "before" target date, applied only to
  what *appears* in the periodic checker's messages (`applyPrefsToEvents`,
  `filterCategoryResultsByPrefs`) or gets fetched for `/acum` (`selectCategories`) — never
  to what the checker reads/diffs for its own state, see `src/check.js` above. The
  location filter (`categoryMatchesPrefs`) applies only to `examType === 'practic'`,
  deliberately — teoretic's one filiala (Salcâmilor) shares a `locationId` with one of
  practic's three, and must not disappear just because the user unchecked that location
  under practic. `togglePref`/`parsePrefBeforeInput` are pure and immutable (used
  directly by `test/prefs.test.js`); `buildSettingsKeyboard`/`buildSettingsSummary` build
  the `/setari` message. Deliberately does **not** store the vehicle choice (that stays
  on `person`, in `registration.js`/`userStore.js`) — vehicle changes what gets *fetched*
  from ASP (it's baked into `servicePath`), while everything in `prefs.js` only changes
  what gets *shown*; storing vehicle in two places would let them drift.
- **`scripts/set-commands.mjs`** — one-off script (`npm run set-commands`) that registers
  the command list in Telegram's native "Menu" button next to the text field, with a
  reduced list scoped just to the owner's chat (no `/inregistrare`/`/sterge` — meaningless
  for someone whose data comes from `.env`, not Redis — but with `/utilizatori` and
  `/revoca`, meaningless for anyone else; both lists include `/setari`). Re-run only when
  the command list changes, not on every deploy.

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
sooner than before", not raw diffing of every open/close event. `/setari` preferences
(`src/prefs.js`) only filter which of these events end up in the message text — the
classification itself (computed in `state.js`'s `computeDiff`) always runs over every
monitored category, unaffected by any chat's preferences.
