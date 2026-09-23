// Preferinte per chat (`/setari`) -- ce categorii intra in alertele/heartbeat-ul trimise
// automat de checker (src/check.js) si ce se citeste la /acum. NU e acelasi lucru cu
// vehiculul (manual/automat, vezi registration.js) -- vehiculul schimba CE se citeste de
// la ASP (afecteaza fetch-ul, deci trebuie sa ramana pe `person`, sursa de adevar pentru
// diff-ul din state.js), in timp ce prefs.js filtreaza doar CE APARE in mesaje. Un chat
// fara prefs salvate foloseste DEFAULT_PREFS (comportamentul de dinainte de /setari: tot
// e activat).
//
// Fara date personale -- doar boolean-uri + o data tinta -- deci userStore.js le stocheaza
// NEcriptat si fara TTL (vezi comentariul de acolo), spre deosebire de person:/access:.

import { buildCategories, DEFAULT_VEHICLE } from './config.js';
import { escapeMarkdownV2, formatDateHuman } from './format.js';

export const SETTINGS_COMMAND = '/setari';

// Trimis dupa apasarea butonului "📅 Până la" din tastatura de setari -- pasul urmator
// (raspunsul userului) e citit ca `pending: { step: 'prefBefore' }` in webhook, NU prin
// advanceRegistration (registration.js) -- e un flux separat, desi foloseste aceeasi
// cheie `pending:<chatId>` din userStore.js.
export const PREF_BEFORE_PROMPT = `📅 ${escapeMarkdownV2('Scrie o dată țintă (DD.MM.YYYY), sau 0 ca să o ștergi.')}`;

export const DEFAULT_PREFS = {
  teoretic: true,
  practic: true,
  obisnuit: true,
  urgent: true,
  locations: { radautanu: true, ieasilor: true, salcamilor: true },
  before: null, // "YYYY-MM-DD" sau null -- fara tinta, comportamentul implicit
};

const BOOLEAN_LOCATION_KEYS = ['radautanu', 'ieasilor', 'salcamilor'];

/** Completeaza un record posibil partial/vechi/corupt cu valorile implicite -- niciodata nu arunca. */
export function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rLoc = r.locations && typeof r.locations === 'object' ? r.locations : {};
  return {
    teoretic: typeof r.teoretic === 'boolean' ? r.teoretic : DEFAULT_PREFS.teoretic,
    practic: typeof r.practic === 'boolean' ? r.practic : DEFAULT_PREFS.practic,
    obisnuit: typeof r.obisnuit === 'boolean' ? r.obisnuit : DEFAULT_PREFS.obisnuit,
    urgent: typeof r.urgent === 'boolean' ? r.urgent : DEFAULT_PREFS.urgent,
    locations: Object.fromEntries(
      BOOLEAN_LOCATION_KEYS.map((loc) => [loc, typeof rLoc[loc] === 'boolean' ? rLoc[loc] : DEFAULT_PREFS.locations[loc]]),
    ),
    before: typeof r.before === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.before) ? r.before : null,
  };
}

/**
 * true daca `category` trece filtrele curente. Filtrul de locatie se aplica DOAR practicului
 * -- teoretic are o singura filiala (Salcâmilor), care nu trebuie sa dispara doar pentru ca
 * userul a debifat Salcâmilor de la practic (cele doua sunt concepte diferite desi coincid
 * ca locationId).
 */
export function categoryMatchesPrefs(category, prefs) {
  if (category.examType === 'teoretic' && !prefs.teoretic) return false;
  if (category.examType === 'practic' && !prefs.practic) return false;
  if (category.urgent && !prefs.urgent) return false;
  if (!category.urgent && !prefs.obisnuit) return false;
  if (category.examType === 'practic' && prefs.locations[category.locationId] === false) return false;
  return true;
}

/** Categoriile de citit pentru /acum, dupa preferinte + vehicul (vezi comentariul de sus). */
export function selectCategories(prefs, vehicle = DEFAULT_VEHICLE) {
  return buildCategories(vehicle).filter((c) => categoryMatchesPrefs(c, prefs));
}

/** categoryResults (deja citite) filtrate dupa preferinte -- pentru heartbeat, nu schimba ce s-a citit/diff-uit. */
export function filterCategoryResultsByPrefs(prefs, categoryResults) {
  return categoryResults.filter((cr) => categoryMatchesPrefs(cr.category, prefs));
}

function withinBefore(dateStr, before) {
  return !before || dateStr <= before;
}

/** earlierDays/newLaterDays (din computeDiff) filtrate dupa categorie + tinta de data ("Până la"). */
export function applyPrefsToEvents(prefs, { earlierDays, newLaterDays }) {
  return {
    earlierDays: earlierDays.filter((e) => categoryMatchesPrefs(e.category, prefs) && withinBefore(e.newDate, prefs.before)),
    newLaterDays: newLaterDays.filter((e) => categoryMatchesPrefs(e.category, prefs) && withinBefore(e.date, prefs.before)),
  };
}

const TOGGLE_KEYS = new Set(['teoretic', 'practic', 'obisnuit', 'urgent']);

/**
 * Inverseaza un flag boolean dupa `path` (vezi callback_data-urile din buildSettingsKeyboard):
 * 'teoretic'/'practic'/'obisnuit'/'urgent' sau 'loc:<id>'. Un path necunoscut (buton vechi
 * dintr-un mesaj stricat) intoarce prefs neschimbate, nu arunca eroare.
 */
export function togglePref(prefs, path) {
  if (TOGGLE_KEYS.has(path)) {
    return { ...prefs, [path]: !prefs[path] };
  }
  if (path.startsWith('loc:')) {
    const loc = path.slice('loc:'.length);
    if (!(loc in prefs.locations)) return prefs;
    return { ...prefs, locations: { ...prefs.locations, [loc]: !prefs.locations[loc] } };
  }
  return prefs;
}

/** Parseaza raspunsul la promptul "Până la" -- "0"/"șterge" sterge tinta, altfel DD.MM.YYYY sau YYYY-MM-DD. */
export function parsePrefBeforeInput(text) {
  const v = text.trim();
  if (v === '0' || /^(sterge|șterge|clear)$/i.test(v)) return { ok: true, before: null };

  let year, month, day;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const human = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (iso) {
    [, year, month, day] = iso;
  } else if (human) {
    [, day, month, year] = human;
  } else {
    return { ok: false };
  }
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  const valid =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 2024 && y <= 2100;
  if (!valid) return { ok: false };
  return { ok: true, before: `${year}-${month}-${day}` };
}

function toggleLabel(on, label) {
  return `${on ? '✅' : '❌'} ${label}`;
}

/**
 * `{ vehicle, canChangeVehicle }` -- canChangeVehicle e false pentru proprietar (vehiculul
 * lui e fix, din .env -- nu exista `person` in Redis pentru proprietar de modificat).
 */
export function buildSettingsKeyboard(prefs, { vehicle, canChangeVehicle } = {}) {
  const rows = [
    [
      { text: toggleLabel(prefs.teoretic, 'Teoretic'), callback_data: 'pref:teoretic' },
      { text: toggleLabel(prefs.practic, 'Practic'), callback_data: 'pref:practic' },
    ],
    [
      { text: toggleLabel(prefs.obisnuit, 'Obișnuit'), callback_data: 'pref:obisnuit' },
      { text: toggleLabel(prefs.urgent, 'Urgent'), callback_data: 'pref:urgent' },
    ],
    [
      { text: toggleLabel(prefs.locations.radautanu, 'Rădăuțanu'), callback_data: 'pref:loc:radautanu' },
      { text: toggleLabel(prefs.locations.ieasilor, 'Ieșilor'), callback_data: 'pref:loc:ieasilor' },
      { text: toggleLabel(prefs.locations.salcamilor, 'Salcâmilor'), callback_data: 'pref:loc:salcamilor' },
    ],
    [
      {
        text: prefs.before ? `📅 Până la: ${formatDateHuman(prefs.before)}` : '📅 Până la: oricând',
        callback_data: 'pref:before',
      },
    ],
  ];
  if (canChangeVehicle) {
    rows.push([
      { text: vehicle === 'BAutomatic' ? '⚙️ Vehicul: automată' : '🔧 Vehicul: manuală', callback_data: 'pref:vehicle' },
    ]);
  }
  return { inline_keyboard: rows };
}

export function buildSettingsSummary() {
  return [
    `⚙️ *${escapeMarkdownV2('Setările tale')}*`,
    '',
    escapeMarkdownV2('Apasă un buton ca să pornești/oprești -- doar ce e ✅ apare la /acum și în alerte.'),
  ].join('\n');
}
