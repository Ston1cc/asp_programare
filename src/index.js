// Orchestrator: interogheaza ASP pentru toate categoriile, pentru owner (persoana din .env)
// SI pentru fiecare utilizator inregistrat prin "/inregistrare" pe Telegram, calculeaza
// diff-ul fata de rularea anterioara PER PERSOANA (owner si fiecare user au propriul istoric
// de "earliest"/"slots", pentru ca ASP poate intoarce date diferite in functie de cine
// intreaba), trimite alerte + heartbeat zilnic fiecaruia pe propriul chat, salveaza state-ul.

import { fileURLToPath } from 'node:url';
import { CATEGORIES, loadConfig } from './config.js';
import { fetchCategoryDates } from './asp.js';
import { loadState, saveState, computeDiff, emptyUserState } from './state.js';
import { loadUsersLocal } from './users.js';
import {
  filterCurrentAndNextMonth,
  buildAlertMessage,
  buildHeartbeatMessage,
  buildFailureMessage,
  getLocalDateString,
  getLocalParts,
} from './format.js';
import { sendTelegramMessage } from './telegram.js';

const STATE_PATH = fileURLToPath(new URL('../state/slots.json', import.meta.url));
const USERS_PATH = fileURLToPath(new URL('../state/users.json', import.meta.url));
const FAILURE_THRESHOLD = 3;
const HEARTBEAT_HOUR = 7;
const HEARTBEAT_MINUTE = 30;

async function fetchAllCategories(person, now) {
  const categoryResults = [];
  const errors = [];
  for (const category of CATEGORIES) {
    try {
      const dates = await fetchCategoryDates(category, person);
      categoryResults.push({ category, dates: filterCurrentAndNextMonth(dates, now) });
    } catch (err) {
      errors.push([category.label, err.message]);
    }
  }
  return { categoryResults, errors };
}

/**
 * Proceseaza un singur target (owner-ul din .env sau un utilizator inregistrat): failure
 * tracking, diff + alerta, heartbeat zilnic / de pornire -- exact logica dinainte, cand exista
 * un singur target hardcodat, extrasa aici ca sa se aplice identic fiecarui utilizator.
 */
function processTarget({ subState, categoryResults, errors, now, isFirstEverRun }) {
  const messages = [];
  let next = { ...subState };

  if (categoryResults.length > 0) {
    const { earlierDays, newLaterDays, nextState: computed } = computeDiff(subState, categoryResults);
    next = { ...next, ...computed };
    const alertMsg = buildAlertMessage({ earlierDays, newLaterDays });
    if (alertMsg) messages.push(alertMsg);
  }

  // Doar categoriile esuate conteaza pentru streak; daca toate au mers, resetam la 0.
  const allFailed = errors.length === CATEGORIES.length;
  next.consecutiveFailures = allFailed ? (subState.consecutiveFailures ?? 0) + 1 : 0;
  if (next.consecutiveFailures === FAILURE_THRESHOLD) {
    messages.push(buildFailureMessage(errors));
  }

  const { hour: localHour, minute: localMinute } = getLocalParts(now);
  const todayLocal = getLocalDateString(now);
  const heartbeatDue =
    localHour * 60 + localMinute >= HEARTBEAT_HOUR * 60 + HEARTBEAT_MINUTE &&
    next.lastHeartbeatDate !== todayLocal;

  if (heartbeatDue && categoryResults.length > 0) {
    messages.push(buildHeartbeatMessage({ categoryResults, now }));
    next.lastHeartbeatDate = todayLocal;
  } else if (isFirstEverRun && categoryResults.length > 0) {
    // Fara asta, daca prima rulare a userului cade inainte de ora heartbeat-ului, nu primeste
    // niciun mesaj si n-are cum sa stie ca inregistrarea chiar a functionat.
    messages.push(buildHeartbeatMessage({ categoryResults, now, title: 'Monitor pornit — prima citire' }));
  }

  return { messages, nextSubState: next, allFailed };
}

async function main() {
  const config = loadConfig();
  const state = await loadState(STATE_PATH);
  const users = await loadUsersLocal(USERS_PATH);
  const now = new Date();

  const targets = [
    { chatId: String(config.telegram.chatId), person: config.person, isOwner: true },
    ...Object.entries(users).map(([chatId, u]) => ({
      chatId,
      person: { idnp: u.idnp, seriaAndNumber: u.seriaAndNumber, issueDate: u.issueDate },
      isOwner: false,
    })),
  ];

  const nextState = { ...state, users: { ...(state.users ?? {}) } };
  let totalMessages = 0;
  let totalErrors = 0;
  let ownerAllFailed = false;

  for (const target of targets) {
    const { categoryResults, errors } = await fetchAllCategories(target.person, now);
    totalErrors += errors.length;
    for (const [label, message] of errors) {
      console.error(`[${target.isOwner ? 'owner' : target.chatId}:${label}] esuat: ${message}`);
    }

    const subState = target.isOwner ? state : (state.users?.[target.chatId] ?? emptyUserState());
    const isFirstEverRun = Object.keys(subState.initialized ?? {}).length === 0;

    const { messages, nextSubState, allFailed } = processTarget({
      subState,
      categoryResults,
      errors,
      now,
      isFirstEverRun,
    });

    if (target.isOwner) {
      Object.assign(nextState, nextSubState);
      ownerAllFailed = allFailed;
    } else {
      nextState.users[target.chatId] = nextSubState;
    }

    for (const msg of messages) {
      await sendTelegramMessage(config.telegram, msg, target.chatId);
      totalMessages++;
    }
  }

  nextState.lastRun = now.toISOString();
  await saveState(STATE_PATH, nextState);

  console.log(
    `OK — ${targets.length} target(e) (owner + ${targets.length - 1} inregistrati), ` +
      `${totalMessages} mesaje trimise, ${totalErrors} erori.`,
  );

  // Esec de proces doar daca TOATE categoriile owner-ului au picat -- vizibilitate in Actions,
  // ca inainte. Un user inregistrat cu date gresite (IDNP/serie invalide la ASP) nu trebuie sa
  // faca CI-ul rosu -- el primeste oricum mesajul de esec pe propriul chat, la al 3-lea streak.
  if (ownerAllFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Eroare fatala:', err);
  process.exitCode = 1;
});
