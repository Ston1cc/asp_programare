// Orchestrator: interogheaza ASP pentru toate categoriile, calculeaza diff-ul fata de
// rularea anterioara, trimite alerte + heartbeat zilnic pe Telegram, salveaza state-ul.
// Doar proprietarul (datele din .env, state in fisier). Notificarile invitatilor ruleaza
// separat, in api/notify-guests.js (Vercel), apelat din check.yml dupa acest script -- ca
// cheia de criptare a datelor lor sa nu trebuiasca copiata in GitHub.

import { fileURLToPath } from 'node:url';
import { CATEGORIES, VERCEL_BASE_URL, loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { buildBackupSwitchMessage, buildFailureMessage, buildRateLimitMessage } from './format.js';
import { fetchCategoryDates, RateLimitError } from './asp.js';
import { sendTelegramMessage } from './telegram.js';
import { checkPerson } from './check.js';
import { DEFAULT_PREFS, normalizePrefs } from './prefs.js';

const STATE_PATH = fileURLToPath(new URL('../state/slots.json', import.meta.url));
const FAILURE_THRESHOLD = 3;

/**
 * Setarile (/setari) ale proprietarului stau in Redis, accesibil doar de pe Vercel -- le cerem
 * de la api/owner-prefs.js cu NOTIFY_SECRET. Orice esec (fara secret = rulare locala, retea,
 * 401) cade pe DEFAULT_PREFS: vezi tot, exact ca inainte de /setari -- mai bine o alerta in
 * plus decat una pierduta din cauza unei dependente de retea.
 */
async function loadOwnerPrefs() {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret) return DEFAULT_PREFS;
  try {
    const res = await fetch(`${VERCEL_BASE_URL}/api/owner-prefs`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { prefs } = await res.json();
    console.log('prefs proprietar: incarcate.');
    return normalizePrefs(prefs);
  } catch (err) {
    console.error(`prefs proprietar: nu am putut sa le incarc (${err.message}) -- folosesc implicitele.`);
    return DEFAULT_PREFS;
  }
}

/** Verificarea proprietarului. Intoarce true daca TOATE categoriile au picat (esec real). */
async function runOwner(config, now, cache) {
  const state = await loadState(STATE_PATH);

  // --- Circuit breaker ASP 429 ---
  // ASP limiteaza per IDNP, zilnic (verificat live 24.09.2026, reset 00:00 UTC). Cat timp
  // limita e activa, fiecare cerere e irosita si doar prelungeste problema -- deci zero
  // cereri pana la `rateLimitedUntil`, nu retry-uri. Cu identitate de rezerva (ASP_IDNP_2),
  // fiecare identitate are propria limita; zero cereri doar cand TOATE sunt blocate.
  const activeUntil = (iso) => (iso && now < new Date(iso) ? new Date(iso) : null);
  const primary = { person: config.person, blockedUntil: activeUntil(state.rateLimitedUntil), count: 0 };
  const backup = config.backupPerson
    ? { person: config.backupPerson, blockedUntil: activeUntil(state.backupRateLimitedUntil), count: 0 }
    : null;
  const identities = backup ? [primary, backup] : [primary];

  if (identities.every((id) => id.blockedUntil)) {
    console.log(
      `ASP a limitat ${backup ? 'ambele IDNP-uri (principal + rezerva)' : 'IDNP-ul proprietarului'} -- nicio cerere facuta.`,
    );
    state.lastRun = now.toISOString();
    await saveState(STATE_PATH, state);
    return false;
  }
  const primaryBlockedAtStart = Boolean(primary.blockedUntil);

  // Contor zilnic (ziua UTC, ca resetul ASP) -- doar pentru vizibilitate in loguri.
  const todayUtc = now.toISOString().slice(0, 10);
  if (state.aspDaily?.date !== todayUtc) state.aspDaily = { date: todayUtc, count: 0 };
  if (state.aspDailyBackup?.date !== todayUtc) state.aspDailyBackup = { date: todayUtc, count: 0 };

  // Failover per cerere: incearca identitatile nelimitate in ordine; la 429 o marcheaza
  // blocata si reia aceeasi categorie pe urmatoarea. Doar cand toate sunt blocate arunca
  // RateLimitError (cu cea mai devreme reluare), pe care checkPerson il trateaza ca pana acum.
  const fetchDates = async (category, _person, opts) => {
    for (const id of identities) {
      if (id.blockedUntil) continue;
      id.count += 1;
      try {
        return await fetchCategoryDates(category, id.person, opts);
      } catch (err) {
        if (!(err instanceof RateLimitError)) throw err;
        console.error(`[${category.key}] ${id === primary ? 'principal' : 'rezerva'} limitat: ${err.message}`);
        id.blockedUntil = err.until;
      }
    }
    const earliest = new Date(Math.min(...identities.map((id) => id.blockedUntil.getTime())));
    throw new RateLimitError(category.key, earliest);
  };

  const prefs = await loadOwnerPrefs();
  const result = await checkPerson({ person: config.person, state, now, cache, prefs, fetchDates });
  const { messages: dataMessages, categoryResults, errors, rateLimit } = result;
  const nextState = result.nextState;
  nextState.aspDaily = { date: todayUtc, count: state.aspDaily.count + primary.count };
  nextState.aspDailyBackup = { date: todayUtc, count: state.aspDailyBackup.count + (backup?.count ?? 0) };

  const messages = [];

  // --- Failure tracking ---
  // Doar categoriile esuate conteaza pentru streak-ul de esecuri; daca toate au mers,
  // resetam la 0. Trimitem alerta o singura data, exact cand streak-ul atinge pragul, ca sa
  // nu spamam la fiecare rulare ulterioara cat timp problema persista. O rulare limitata de
  // ASP nu e un esec de citire (nu spune nimic despre structura site-ului) -- streak-ul
  // ramane neatins, iar utilizatorul primeste un mesaj dedicat, o singura data.
  const allFailed = !rateLimit && errors.length === CATEGORIES.length;
  if (rateLimit) {
    messages.push(
      buildRateLimitMessage({
        until: rateLimit.until,
        countToday: nextState.aspDaily.count + nextState.aspDailyBackup.count,
        now,
      }),
    );
  } else {
    nextState.consecutiveFailures = allFailed ? state.consecutiveFailures + 1 : 0;
    if (nextState.consecutiveFailures === FAILURE_THRESHOLD) {
      messages.push(buildFailureMessage(errors));
    }
    // Principalul tocmai a fost limitat in aceasta rulare, dar rezerva a preluat -- o singura
    // notificare (la rulari urmatoare principalul e deja blocat din start, deci tacem).
    if (backup && !primaryBlockedAtStart && primary.blockedUntil) {
      messages.push(buildBackupSwitchMessage({ until: primary.blockedUntil, countToday: nextState.aspDaily.count, now }));
    }
  }
  messages.push(...dataMessages);

  // null cand rularea a mers -- o limita expirata nu ramane agatata in state.
  nextState.rateLimitedUntil = primary.blockedUntil ? primary.blockedUntil.toISOString() : null;
  nextState.backupRateLimitedUntil = backup?.blockedUntil ? backup.blockedUntil.toISOString() : null;
  nextState.lastRun = now.toISOString();

  for (const msg of messages) {
    await sendTelegramMessage(config.telegram, msg);
  }

  await saveState(STATE_PATH, nextState);

  console.log(
    `OK — ${categoryResults.length}/${CATEGORIES.length} categorii citite, ${messages.length} mesaje trimise, ${errors.length} erori, ` +
      `${nextState.aspDaily.count} cereri ASP azi (UTC)` +
      (backup ? ` (+${nextState.aspDailyBackup.count} pe rezerva)` : '') +
      (rateLimit ? `, LIMITAT pana la ${rateLimit.until.toISOString()}.` : '.'),
  );

  return allFailed;
}

async function main() {
  const config = loadConfig();
  const now = new Date();
  const allFailed = await runOwner(config, now, new Map());

  // Esec de proces doar daca TOATE categoriile au picat -- o categorie izolata nu trebuie
  // sa faca CI-ul rosu, dar o cadere totala merita vizibilitate in Actions.
  if (allFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Eroare fatala:', err);
  process.exitCode = 1;
});
