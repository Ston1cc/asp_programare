// Persistenta si logica de diff. Statul se comite inapoi in repo de catre workflow-ul CI
// (runnerul GH e efemer), deci acest fisier trateaza citirea/scrierea ca simplu JSON local.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_STATE = () => ({
  lastRun: null,
  lastHeartbeatDate: null,
  consecutiveFailures: 0,
  earliest: {}, // { [categoryKey]: "YYYY-MM-DD" }
  slots: {}, // { "categoryKey|YYYY-MM-DD": { date, timeSlots } }
  initialized: {}, // { [categoryKey]: true } -- odata setat, categoria a fost deja evaluata
  // ISO -- cat timp `now` e inainte de aceasta valoare, ASP a limitat IDNP-ul (HTTP 429,
  // cota zilnica) si NU facem nicio cerere; vezi RateLimitError in asp.js.
  rateLimitedUntil: null,
  // Cereri `dates` facute in ziua UTC curenta (cota ASP se reseteaza la 00:00 UTC) -- doar
  // pentru vizibilitate in loguri, ca sa aflam cota reala din date, nu din estimari.
  aspDaily: { date: null, count: 0 },
});

export async function loadState(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...EMPTY_STATE(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return EMPTY_STATE();
    }
    throw err;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function slotKey(categoryKey, date) {
  return `${categoryKey}|${date}`;
}

/**
 * Compara zilele curente (per categorie, deja filtrate pe luna curenta + urmatoarea)
 * cu statul anterior. Intoarce evenimentele clasificate si noul state (neschimbat inca
 * pe disc -- apelantul decide cand salveaza).
 *
 * Evenimente:
 *  - earlierDays: earliest a scazut pentru o categorie (alerta prioritara)
 *  - newLaterDays: zile noi, dar nu mai devreme decat earliest curent
 *  - (zilele disparute si scaderile de earliest nu genereaza alerta, doar se reflecta in state)
 *
 * O categorie evaluata pentru PRIMA data (niciodata in `state.initialized`) doar isi
 * stabileste baseline-ul, fara niciun eveniment -- altfel prima rulare ar trimite o
 * alerta "record" pentru fiecare categorie, ceea ce n-are sens (nu exista fata de ce
 * sa fie "mai devreme") si ar dubla tot continutul heartbeat-ului din aceeasi zi.
 */
export function computeDiff(state, categoryResults) {
  const newSlots = {};
  const newEarliest = { ...state.earliest };
  const newInitialized = { ...state.initialized };
  const earlierDays = [];
  const newLaterDays = [];

  for (const { category, dates } of categoryResults) {
    const sortedDates = [...dates].sort((a, b) => a.date.localeCompare(b.date));
    const newMin = sortedDates.length > 0 ? sortedDates[0].date : null;
    const prevMin = state.earliest[category.key] ?? null;
    const wasInitialized = Boolean(state.initialized?.[category.key]);

    // Un singur eveniment "record" per categorie (pe newMin), nu per zi -- vezi mai jos.
    const recordBroken = wasInitialized && newMin !== null && (prevMin === null || newMin < prevMin);

    for (const { date, timeSlots } of sortedDates) {
      const key = slotKey(category.key, date);
      newSlots[key] = { date, timeSlots };

      if (!wasInitialized) continue; // baseline silentios, fara evenimente

      const isNew = !(key in state.slots);
      if (!isNew) continue;

      // Ziua care a stabilit noul record e deja raportata prin earlierDays mai jos;
      // orice alta zi noua (indiferent daca e sub vechiul prevMin sau nu) e "later".
      if (recordBroken && date === newMin) continue;
      newLaterDays.push({ category, date, timeSlots });
    }

    if (recordBroken) {
      earlierDays.push({
        category,
        newDate: newMin,
        newTimeSlots: sortedDates[0].timeSlots,
        prevDate: prevMin,
      });
    }

    if (newMin !== null) {
      newEarliest[category.key] = newMin;
    } else {
      delete newEarliest[category.key];
    }
    newInitialized[category.key] = true;
  }

  const nextState = {
    ...state,
    earliest: newEarliest,
    slots: newSlots,
    initialized: newInitialized,
  };

  return { earlierDays, newLaterDays, nextState };
}
