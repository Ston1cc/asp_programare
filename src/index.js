// Orchestrator: interogheaza ASP pentru toate categoriile, calculeaza diff-ul fata de
// rularea anterioara, trimite alerte + heartbeat zilnic pe Telegram, salveaza state-ul.
// Doar proprietarul (datele din .env, state in fisier). Notificarile invitatilor ruleaza
// separat, in api/notify-guests.js (Vercel), apelat din check.yml dupa acest script -- ca
// cheia de criptare a datelor lor sa nu trebuiasca copiata in GitHub.

import { fileURLToPath } from 'node:url';
import { CATEGORIES, loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { buildFailureMessage, buildRateLimitMessage } from './format.js';
import { sendTelegramMessage } from './telegram.js';
import { checkPerson } from './check.js';

const STATE_PATH = fileURLToPath(new URL('../state/slots.json', import.meta.url));
const FAILURE_THRESHOLD = 3;

/** Verificarea proprietarului. Intoarce true daca TOATE categoriile au picat (esec real). */
async function runOwner(config, now, cache) {
  const state = await loadState(STATE_PATH);

  // --- Circuit breaker ASP 429 ---
  // ASP limiteaza per IDNP, zilnic (verificat live 24.09.2026, reset 00:00 UTC). Cat timp
  // limita e activa, fiecare cerere e irosita si doar prelungeste problema -- deci zero
  // cereri pana la `rateLimitedUntil`, nu retry-uri.
  if (state.rateLimitedUntil && now < new Date(state.rateLimitedUntil)) {
    console.log(`ASP a limitat IDNP-ul proprietarului pana la ${state.rateLimitedUntil} -- nicio cerere facuta.`);
    state.lastRun = now.toISOString();
    await saveState(STATE_PATH, state);
    return false;
  }

  // Contor zilnic (ziua UTC, ca resetul ASP) -- doar pentru vizibilitate in loguri.
  const todayUtc = now.toISOString().slice(0, 10);
  if (state.aspDaily?.date !== todayUtc) state.aspDaily = { date: todayUtc, count: 0 };

  const result = await checkPerson({ person: config.person, state, now, cache });
  const { messages: dataMessages, categoryResults, errors, rateLimit, attempted } = result;
  const nextState = result.nextState;
  nextState.aspDaily = { date: todayUtc, count: state.aspDaily.count + attempted };

  const messages = [];

  // --- Failure tracking ---
  // Doar categoriile esuate conteaza pentru streak-ul de esecuri; daca toate au mers,
  // resetam la 0. Trimitem alerta o singura data, exact cand streak-ul atinge pragul, ca sa
  // nu spamam la fiecare rulare ulterioara cat timp problema persista. O rulare limitata de
  // ASP nu e un esec de citire (nu spune nimic despre structura site-ului) -- streak-ul
  // ramane neatins, iar utilizatorul primeste un mesaj dedicat, o singura data.
  const allFailed = !rateLimit && errors.length === CATEGORIES.length;
  if (rateLimit) {
    messages.push(buildRateLimitMessage({ until: rateLimit.until, countToday: nextState.aspDaily.count, now }));
  } else {
    nextState.consecutiveFailures = allFailed ? state.consecutiveFailures + 1 : 0;
    if (nextState.consecutiveFailures === FAILURE_THRESHOLD) {
      messages.push(buildFailureMessage(errors));
    }
  }
  messages.push(...dataMessages);

  // null cand rularea a mers -- o limita expirata nu ramane agatata in state.
  nextState.rateLimitedUntil = rateLimit ? rateLimit.until.toISOString() : null;
  nextState.lastRun = now.toISOString();

  for (const msg of messages) {
    await sendTelegramMessage(config.telegram, msg);
  }

  await saveState(STATE_PATH, nextState);

  console.log(
    `OK — ${categoryResults.length}/${CATEGORIES.length} categorii citite, ${messages.length} mesaje trimise, ${errors.length} erori, ` +
      `${nextState.aspDaily.count} cereri ASP azi (UTC)` +
      (rateLimit ? `, LIMITAT pana la ${nextState.rateLimitedUntil}.` : '.'),
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
