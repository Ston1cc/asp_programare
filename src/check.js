// Verificarea unei singure persoane: fetch pe toate categoriile, diff fata de state-ul ei,
// alerta + heartbeat zilnic. Partajata intre proprietar (src/index.js, state in fisier) si
// invitati (src/guests.js, state in Redis) ca logica sa nu fie duplicata. Nu trimite nimic
// si nu scrie nimic -- intoarce mesajele si noul state, apelantul decide ce face cu ele.

import { CATEGORIES } from './config.js';
import { fetchCategoryDates, RateLimitError } from './asp.js';
import { computeDiff, forgetCategories } from './state.js';
import { DEFAULT_PREFS, applyPrefsToEvents, filterCategoryResultsByPrefs, hasDateWindow, selectCategories } from './prefs.js';
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
 *
 * `prefs` (src/prefs.js, /setari): categoriile dezactivate NU se citesc (cota ASP) si sunt uitate
 * din state (forgetCategories) -- la reactivare au un baseline nou, deci fara "record" fals.
 * Filtrul pe data ("Pana la"/"Ultimul examen") ramane doar de afisare.
 */
export async function checkPerson({ person, state, now = new Date(), cache, categories, prefs = DEFAULT_PREFS, fetchDates = fetchCategoryDates }) {
  // Se citesc DOAR categoriile active din /setari (mai putine cereri din cota ASP). `categories`
  // explicit are prioritate (teste).
  const toFetch = categories ?? selectCategories(prefs);
  const categoryResults = [];
  const errors = [];
  let rateLimit = null;
  let attempted = 0;

  for (const category of toFetch) {
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

  // Categoriile dezactivate nu se mai citesc, deci le uitam din state: la reactivare, prima citire
  // e un baseline silentios, nu o comparatie cu date vechi (alerte "record" false). Se face si
  // cand nu s-a citit nimic, ca state-ul sa reflecte mereu setarile curente.
  const toFetchKeys = new Set(toFetch.map((c) => c.key));
  let nextState = forgetCategories(
    state,
    CATEGORIES.filter((c) => !toFetchKeys.has(c.key)).map((c) => c.key),
  );
  // Evenimentele brute din diff (inainte de filtrarea dupa preferinte) -- pentru statistici (stats.js).
  let events = { earlierDays: [], newLaterDays: [] };
  if (categoryResults.length > 0) {
    const { earlierDays, newLaterDays, nextState: computedState } = computeDiff(nextState, categoryResults);
    nextState = computedState;
    events = { earlierDays, newLaterDays };
    // Implicit, doar zilele MAI DEVREME decat minimul precedent declanseaza o alerta. Zilele noi
    // dar mai tarzii (`newLaterDays` din computeDiff) nu sunt trimise: nu ajuta pe nimeni sa se
    // programeze mai repede si erau doar zgomot. computeDiff le calculeaza oricum, ca sa isi
    // tina `slots` la zi.
    // EXCEPTIE: cu o fereastra de date setata (/setari -> "Pana la" si/sau "Ultimul examen"),
    // userul vrea ORICE loc nou eliberat in fereastra, nu doar recorduri -- un loc aparut pe
    // 24.11 cand minimul e deja 20.11 nu e "mai devreme", dar e exact ce a cerut. Si invers:
    // un "record" de pe 21.11 ar fi inutil daca prima data rezervabila e 24.11, iar zilele
    // rezervabile de dupa el n-ar mai alerta niciodata. applyPrefsToEvents taie tot ce iese din
    // fereastra (inainte de data minima sau dupa tinta).
    const laterForAlert = hasDateWindow(prefs) ? newLaterDays : [];
    const alertMsg = buildAlertMessage(applyPrefsToEvents(prefs, { earlierDays, newLaterDays: laterForAlert }));
    if (alertMsg) messages.push(alertMsg);
  }

  // Rezumatul/prima citire arata doar categoriile alese; daca nu a ramas niciuna, nu trimitem
  // un rezumat gol, dar ziua de rezumat se considera tratata (altfel se reincearca la fiecare rulare).
  const shownResults = filterCategoryResultsByPrefs(prefs, categoryResults);

  const { hour: localHour, minute: localMinute } = getLocalParts(now);
  const todayLocal = getLocalDateString(now);
  const heartbeatDue =
    localHour * 60 + localMinute >= HEARTBEAT_HOUR * 60 + HEARTBEAT_MINUTE &&
    nextState.lastHeartbeatDate !== todayLocal;
  if (heartbeatDue && categoryResults.length > 0) {
    if (shownResults.length > 0) messages.push(buildHeartbeatMessage({ categoryResults: shownResults, now }));
    nextState = { ...nextState, lastHeartbeatDate: todayLocal };
  } else if (isFirstEverRun && shownResults.length > 0) {
    // Fara asta, daca prima rulare cade inainte de ora heartbeat-ului, persoana nu primeste
    // niciun mesaj si nu are cum sa stie ca monitorul chiar functioneaza.
    messages.push(buildHeartbeatMessage({ categoryResults: shownResults, now, title: 'Monitor pornit — prima citire' }));
  }

  return { nextState, messages, categoryResults, errors, rateLimit, attempted, isFirstEverRun, events };
}
