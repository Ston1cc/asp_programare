// Verificarea unei singure persoane: fetch pe toate categoriile, diff fata de state-ul ei,
// alerta + heartbeat zilnic. Partajata intre proprietar (src/index.js, state in fisier) si
// invitati (src/guests.js, state in Redis) ca logica sa nu fie duplicata. Nu trimite nimic
// si nu scrie nimic -- intoarce mesajele si noul state, apelantul decide ce face cu ele.

import { CATEGORIES } from './config.js';
import { fetchCategoryDates, RateLimitError } from './asp.js';
import { computeDiff } from './state.js';
import {
  filterCurrentAndNextMonth,
  buildAlertMessage,
  buildHeartbeatMessage,
  getLocalDateString,
  getLocalParts,
} from './format.js';

export const HEARTBEAT_HOUR = 7;
export const HEARTBEAT_MINUTE = 30;

/**
 * `cache` (optional, un Map per rulare) -- partajat intre persoane: get-service/locations
 * nu contin IDNP, deci raspunsul e acelasi pentru toti; doar `dates` se cere per persoana.
 *
 * Intoarce { nextState, messages, categoryResults, errors, rateLimit, attempted,
 * isFirstEverRun }. `messages` = doar mesajele de DATE (alerta + heartbeat); mesajul de
 * limita ASP si alerta de esec le adauga apelantul (difera intre proprietar si invitati).
 * La prima RateLimitError opreste bucla -- restul categoriilor ar primi acelasi 429.
 */
export async function checkPerson({ person, state, now = new Date(), cache, categories = CATEGORIES, fetchDates = fetchCategoryDates }) {
  const categoryResults = [];
  const errors = [];
  let rateLimit = null;
  let attempted = 0;

  for (const category of categories) {
    try {
      // Numarat inainte de fetch: aproximeaza cererile `dates` (get-service/locations nu au
      // IDNP si nu conteaza la cota).
      attempted += 1;
      const dates = await fetchDates(category, person, { cache });
      categoryResults.push({ category, dates: filterCurrentAndNextMonth(dates, now) });
    } catch (err) {
      if (err instanceof RateLimitError) {
        console.error(`[${category.key}] ${err.message}`);
        rateLimit = err;
        break;
      }
      console.error(`[${category.key}] esuat: ${err.message}`);
      errors.push([category.label, err.message]);
    }
  }

  // Prima rulare vreodata (nicio categorie n-a fost initializata pana acum) -- folosit mai
  // jos ca sa trimitem o confirmare clara ca monitorul a pornit, in loc sa taci pana la
  // primul eveniment real sau pana la ora heartbeat-ului.
  const isFirstEverRun = Object.keys(state.initialized ?? {}).length === 0;
  const messages = [];

  let nextState = state;
  if (categoryResults.length > 0) {
    const { earlierDays, newLaterDays, nextState: computedState } = computeDiff(state, categoryResults);
    nextState = computedState;
    const alertMsg = buildAlertMessage({ earlierDays, newLaterDays });
    if (alertMsg) messages.push(alertMsg);
  }

  const { hour: localHour, minute: localMinute } = getLocalParts(now);
  const todayLocal = getLocalDateString(now);
  const heartbeatDue =
    localHour * 60 + localMinute >= HEARTBEAT_HOUR * 60 + HEARTBEAT_MINUTE &&
    nextState.lastHeartbeatDate !== todayLocal;
  if (heartbeatDue && categoryResults.length > 0) {
    messages.push(buildHeartbeatMessage({ categoryResults, now }));
    nextState = { ...nextState, lastHeartbeatDate: todayLocal };
  } else if (isFirstEverRun && categoryResults.length > 0) {
    // Fara asta, daca prima rulare cade inainte de ora heartbeat-ului, persoana nu primeste
    // niciun mesaj si nu are cum sa stie ca monitorul chiar functioneaza.
    messages.push(buildHeartbeatMessage({ categoryResults, now, title: 'Monitor pornit — prima citire' }));
  }

  return { nextState, messages, categoryResults, errors, rateLimit, attempted, isFirstEverRun };
}
