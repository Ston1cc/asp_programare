// Nucleul verificarii periodice: interogheaza ASP pentru toate categoriile, calculeaza
// diff-ul fata de rularea anterioara, construieste alertele + heartbeat-ul zilnic. Extras
// din fostul src/index.js ca sa poata rula cu doua "store"-uri diferite fara sa duplice
// logica de fetch/diff/heartbeat:
//   - src/index.js       -- runner local, state intr-un fisier (state/slots.json)
//   - api/cron-check.js  -- checkerul de pe Vercel, apelat de un cron extern la ~10 min,
//                            state in Redis (vezi userStore.js) -- inlocuieste vechiul
//                            workflow GitHub Actions, al carui `schedule` era doar
//                            best-effort si putea sari ore intregi in varf de trafic GH.

import { CATEGORIES } from './config.js';
import { fetchCategoryDates } from './asp.js';
import { computeDiff } from './state.js';
import {
  filterWithinHorizon,
  buildAlertMessage,
  buildHeartbeatMessage,
  buildFailureMessage,
  getLocalDateString,
  getLocalParts,
} from './format.js';
import { BOOKING_KEYBOARD } from './telegram.js';
import { applyPrefsToEvents, filterCategoryResultsByPrefs } from './prefs.js';

const HEARTBEAT_HOUR = 7;
const HEARTBEAT_MINUTE = 30;

/**
 * `store` = { load(): Promise<State>, save(state): Promise<void> }.
 * `categories`, optional -- implicit CATEGORIES (toate 8); folosit doar pentru testare,
 * NU pentru filtrarea preferintelor unui user -- toate categoriile monitorizate trebuie
 * mereu citite si diff-uite, altfel reactivarea unei categorii dezactivate din /setari ar
 * parea un fals "record" fata de un state neactualizat de mult timp.
 * `fetchOptions`/`cache` -- optionale, pasate lui fetchCategoryDates; api/cron-check.js le
 * suprascrie cu retry mai scurt + un cache per-apel, ca fetch-urile (facute in paralel mai
 * jos) sa incapa in maxDuration.
 * `failureThreshold` -- numarul de rulari consecutive esuate inainte de alerta de esec;
 * fiecare apelant alege pragul potrivit cadentei lui (index.js: rulari rare, manuale;
 * cron-check.js: la ~10 min, deci un prag mai mare ca sa nu alerteze la un blip trecator).
 *
 * Intoarce `messages` ca { text, keyboard? } -- doar alerta de zile noi/mai devreme
 * primeste BOOKING_KEYBOARD (butonul "Programează-te"); heartbeat-ul si alerta de esec
 * raman fara `keyboard`, ca apelantul sa foloseasca tastatura lui implicita (persistenta).
 *
 * `prefs`, optional (src/prefs.js) -- filtreaza DOAR ce APARE in alerte/heartbeat, nu ce
 * se citeste: toate `categories` sunt mereu fetch-uite si diff-uite (vezi comentariul de
 * la parametrul `categories` mai sus), altfel reactivarea unei categorii din /setari ar
 * parea un fals "record" fata de un state neactualizat de mult timp. Fara `prefs`,
 * comportamentul e identic cu dinainte de /setari (tot ce se citeste apare in mesaje).
 */
export async function runCheck({
  config,
  store,
  now = new Date(),
  categories = CATEGORIES,
  fetchOptions,
  cache,
  failureThreshold = 3,
  fetchDates = fetchCategoryDates, // injectabil -- doar pentru teste, ca sa nu loveasca ASP live
  prefs,
}) {
  const state = await store.load();

  const categoryResults = [];
  const errors = [];

  // Fetch in paralel (nu secvential ca in versiunea veche) -- fara presiune de timp ca la
  // /acum, dar tot merita: la 8 categorii secvential + retry, o rulare poate depasi usor
  // cateva zeci de secunde, apropiindu-se de maxDuration-ul lui cron-check.js.
  await Promise.all(
    categories.map(async (category) => {
      try {
        const dates = await fetchDates(category, config.person, { fetchOptions, cache });
        categoryResults.push({ category, dates: filterWithinHorizon(dates, now) });
      } catch (err) {
        console.error(`[${category.key}] esuat: ${err.message}`);
        errors.push([category.label, err.message]);
      }
    }),
  );
  // Fetch-ul in paralel termina intr-o ordine nedeterminista -- reordonam dupa ordinea din
  // `categories`, ca mesajele (heartbeat, tabelul practic) sa iasa mereu identic structurate.
  categoryResults.sort((a, b) => categories.indexOf(a.category) - categories.indexOf(b.category));

  const messages = [];

  // --- Failure tracking ---
  const allFailed = errors.length === categories.length;
  state.consecutiveFailures = allFailed ? state.consecutiveFailures + 1 : 0;
  if (state.consecutiveFailures === failureThreshold) {
    messages.push({ text: buildFailureMessage(errors, failureThreshold) });
  }

  // Prima rulare vreodata -- vezi comentariul din vechiul index.js: fara asta, daca ea
  // cade inainte de ora heartbeat-ului, userul n-are cum sa stie ca monitorul functioneaza.
  const isFirstEverRun = Object.keys(state.initialized ?? {}).length === 0;

  // --- Diff + alerta ---
  let nextState = state;
  if (categoryResults.length > 0) {
    const { earlierDays, newLaterDays, nextState: computedState } = computeDiff(state, categoryResults);
    nextState = computedState;
    const events = prefs ? applyPrefsToEvents(prefs, { earlierDays, newLaterDays }) : { earlierDays, newLaterDays };
    const alertMsg = buildAlertMessage(events);
    if (alertMsg) messages.push({ text: alertMsg, keyboard: BOOKING_KEYBOARD });
  }

  // --- Heartbeat zilnic ---
  const { hour: localHour, minute: localMinute } = getLocalParts(now);
  const todayLocal = getLocalDateString(now);
  const heartbeatDue =
    localHour * 60 + localMinute >= HEARTBEAT_HOUR * 60 + HEARTBEAT_MINUTE &&
    nextState.lastHeartbeatDate !== todayLocal;
  // Preferintele filtreaza doar CE intra in heartbeat, nu daca heartbeat-ul e trimis --
  // altfel un user care a debifat tot ar ramane blocat fara heartbeat DELOC, fara sa
  // inteleaga de ce (si lastHeartbeatDate tot trebuie marcat, ca sa nu reincercam la
  // fiecare rulare urmatoare din aceeasi zi).
  const heartbeatCategoryResults = prefs ? filterCategoryResultsByPrefs(prefs, categoryResults) : categoryResults;
  if (heartbeatDue && categoryResults.length > 0) {
    messages.push({ text: buildHeartbeatMessage({ categoryResults: heartbeatCategoryResults, now }) });
    nextState.lastHeartbeatDate = todayLocal;
  } else if (isFirstEverRun && categoryResults.length > 0) {
    messages.push({
      text: buildHeartbeatMessage({ categoryResults: heartbeatCategoryResults, now, title: 'Monitor pornit — prima citire' }),
    });
  }

  nextState.lastRun = now.toISOString();

  await store.save(nextState);

  return { messages, errors, allFailed, categoryResults };
}
