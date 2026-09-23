// Orchestrator: interogheaza ASP pentru toate categoriile, calculeaza diff-ul fata de
// rularea anterioara, trimite alerte + heartbeat zilnic pe Telegram, salveaza state-ul.

import { fileURLToPath } from 'node:url';
import { CATEGORIES, loadConfig } from './config.js';
import { fetchCategoryDates } from './asp.js';
import { loadState, saveState, computeDiff } from './state.js';
import {
  filterWithinHorizon,
  buildAlertMessage,
  buildHeartbeatMessage,
  buildFailureMessage,
  getLocalDateString,
  getLocalParts,
} from './format.js';
import { sendTelegramMessage } from './telegram.js';

const STATE_PATH = fileURLToPath(new URL('../state/slots.json', import.meta.url));
const FAILURE_THRESHOLD = 3;
const HEARTBEAT_HOUR = 7;
const HEARTBEAT_MINUTE = 30;

async function main() {
  const config = loadConfig();
  const state = await loadState(STATE_PATH);
  const now = new Date();

  const categoryResults = [];
  const errors = [];

  for (const category of CATEGORIES) {
    try {
      const dates = await fetchCategoryDates(category, config.person);
      const filtered = filterWithinHorizon(dates, now);
      categoryResults.push({ category, dates: filtered });
    } catch (err) {
      console.error(`[${category.key}] esuat: ${err.message}`);
      errors.push([category.label, err.message]);
    }
  }

  const messages = [];

  // --- Failure tracking ---
  // Doar categoriile esuate conteaza pentru streak-ul de esecuri; daca toate au mers,
  // resetam la 0. Trimitem alerta o singura data, exact cand streak-ul atinge pragul,
  // ca sa nu spamam la fiecare rulare ulterioara cat timp problema persista.
  const allFailed = errors.length === CATEGORIES.length;
  state.consecutiveFailures = allFailed ? state.consecutiveFailures + 1 : 0;
  if (state.consecutiveFailures === FAILURE_THRESHOLD) {
    messages.push(buildFailureMessage(errors));
  }

  // Prima rulare vreodata (nicio categorie n-a fost initializata pana acum) -- folosit
  // mai jos ca sa trimitem o confirmare clara ca monitorul a pornit, in loc sa taci
  // pana la primul eveniment real sau pana la ora heartbeat-ului.
  const isFirstEverRun = Object.keys(state.initialized ?? {}).length === 0;

  // --- Diff + alerta ---
  let nextState = state;
  if (categoryResults.length > 0) {
    const { earlierDays, newLaterDays, nextState: computedState } = computeDiff(state, categoryResults);
    nextState = computedState;
    const alertMsg = buildAlertMessage({ earlierDays, newLaterDays });
    if (alertMsg) messages.push(alertMsg);
  }

  // --- Heartbeat zilnic ---
  const { hour: localHour, minute: localMinute } = getLocalParts(now);
  const todayLocal = getLocalDateString(now);
  const heartbeatDue =
    localHour * 60 + localMinute >= HEARTBEAT_HOUR * 60 + HEARTBEAT_MINUTE &&
    nextState.lastHeartbeatDate !== todayLocal;
  if (heartbeatDue && categoryResults.length > 0) {
    messages.push(buildHeartbeatMessage({ categoryResults, now }));
    nextState.lastHeartbeatDate = todayLocal;
  } else if (isFirstEverRun && categoryResults.length > 0) {
    // Fara asta, daca prima rulare cade inainte de ora heartbeat-ului, userul nu
    // primeste niciun mesaj si nu are cum sa stie ca monitorul chiar functioneaza.
    messages.push(buildHeartbeatMessage({ categoryResults, now, title: 'Monitor pornit — prima citire' }));
  }

  nextState.lastRun = now.toISOString();

  for (const msg of messages) {
    await sendTelegramMessage(config.telegram, msg);
  }

  await saveState(STATE_PATH, nextState);

  console.log(
    `OK — ${categoryResults.length}/${CATEGORIES.length} categorii citite, ${messages.length} mesaje trimise, ${errors.length} erori.`,
  );

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
