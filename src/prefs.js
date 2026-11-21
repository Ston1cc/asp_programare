// Preferinte per chat (`/setari`): ce categorii APAR in alertele/rezumatul automat si ce se
// citeste la /acum, plus o data-tinta optionala ("anunta-ma doar pentru date pana la X").
// Se aplica DOAR la afisare -- diff-ul din state.js se calculeaza mereu pe toate categoriile
// (altfel reactivarea unei categorii ar arata ca un "record" fals fata de un baseline vechi).
//
// Fara date personale (doar boolean-uri + o data), deci userStore.js le stocheaza necriptat
// si fara TTL. Un chat fara prefs salvate foloseste DEFAULT_PREFS: tot pornit, ca inainte.

import { CATEGORIES } from './config.js';
import { escapeMarkdownV2, formatDateHuman } from './format.js';

export const SETTINGS_COMMAND = '/setari';

// Trimis dupa apasarea butonului "Pana la"; raspunsul userului e citit ca
// `pending: { step: 'prefBefore' }` in webhook, NU prin advanceRegistration -- flux separat,
// dar aceeasi cheie `pending:<chatId>`.
export const PREF_BEFORE_PROMPT = `📅 ${escapeMarkdownV2('Scrie o dată țintă (DD.MM.YYYY), sau 0 ca să o ștergi.')}`;

// La fel, pentru "Ultimul examen": `pending: { step: 'prefLastExam' }`.
export const PREF_LAST_EXAM_PROMPT = `🗓 ${escapeMarkdownV2('Scrie data ultimului examen susținut (DD.MM.YYYY), sau 0 ca să o ștergi.')}`;

// Dupa un examen picat, urmatoarea incercare se poate da abia peste atatea zile. Pragul e per tip
// de examen, deci un singur camp "De la" nu ajunge -- din data ultimului examen se calculeaza
// prima data rezervabila pentru fiecare tip. Schimba aici daca regula ASP se modifica.
export const MIN_GAP_DAYS = { teoretic: 5, practic: 10 };

export const DEFAULT_PREFS = {
  teoretic: true,
  practic: true,
  obisnuit: true,
  urgent: true,
  locations: { radautanu: true, ieasilor: true, salcamilor: true },
  before: null, // "YYYY-MM-DD" sau null
  lastExam: null, // "YYYY-MM-DD" sau null -- data ultimului examen; vezi MIN_GAP_DAYS
};

const LOCATION_KEYS = Object.keys(DEFAULT_PREFS.locations);

function isoDateOrNull(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** "YYYY-MM-DD" + n zile (calendaristic, in UTC -- fara probleme de fus orar/DST). */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Prima data rezervabila pentru o categorie dupa `lastExam`, sau null daca nu e setat. */
export function minDateFor(category, prefs) {
  return prefs.lastExam ? addDays(prefs.lastExam, MIN_GAP_DAYS[category.examType]) : null;
}

/** Are userul vreo fereastra de date setata ("Pana la" si/sau "Ultimul examen")? */
export function hasDateWindow(prefs) {
  return Boolean(prefs.before || prefs.lastExam);
}

/** Completeaza un record posibil partial/vechi/corupt cu valorile implicite -- niciodata nu arunca. */
export function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rLoc = r.locations && typeof r.locations === 'object' ? r.locations : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    teoretic: bool(r.teoretic, DEFAULT_PREFS.teoretic),
    practic: bool(r.practic, DEFAULT_PREFS.practic),
    obisnuit: bool(r.obisnuit, DEFAULT_PREFS.obisnuit),
    urgent: bool(r.urgent, DEFAULT_PREFS.urgent),
    locations: Object.fromEntries(LOCATION_KEYS.map((k) => [k, bool(rLoc[k], DEFAULT_PREFS.locations[k])])),
    before: isoDateOrNull(r.before),
    lastExam: isoDateOrNull(r.lastExam),
  };
}

/**
 * Filtrul de filiala se aplica DOAR practicului: teoretic are o singura filiala (Salcamilor),
 * care nu trebuie sa dispara doar pentru ca userul a debifat Salcamilor la practic (concepte
 * diferite, desi coincid ca locationId).
 */
export function categoryMatchesPrefs(category, prefs) {
  if (category.examType === 'teoretic' && !prefs.teoretic) return false;
  if (category.examType === 'practic' && !prefs.practic) return false;
  if (category.urgent && !prefs.urgent) return false;
  if (!category.urgent && !prefs.obisnuit) return false;
  if (category.examType === 'practic' && prefs.locations[category.locationId] === false) return false;
  return true;
}

/** Categoriile de citit la /acum -- mai putine cereri ASP cand userul a dezactivat ceva. */
export function selectCategories(prefs) {
  return CATEGORIES.filter((c) => categoryMatchesPrefs(c, prefs));
}

/** Data cade in fereastra userului: >= prima data rezervabila (dupa ultimul examen) si <= tinta. */
function withinWindow(category, dateStr, prefs) {
  const min = minDateFor(category, prefs);
  if (min && dateStr < min) return false;
  return !prefs.before || dateStr <= prefs.before;
}

/**
 * categoryResults deja citite, filtrate dupa preferinte (categorie + fereastra de date) -- pentru
 * rezumat si /acum. O categorie ramane in lista chiar daca tinta ii elimina toate zilele
 * (apare ca "fara zile libere"), ca userul sa vada ca e urmarita.
 */
export function filterCategoryResultsByPrefs(prefs, categoryResults) {
  return categoryResults
    .filter((cr) => categoryMatchesPrefs(cr.category, prefs))
    .map((cr) => (hasDateWindow(prefs) ? { ...cr, dates: cr.dates.filter((d) => withinWindow(cr.category, d.date, prefs)) } : cr));
}

/** earlierDays/newLaterDays (din computeDiff) filtrate dupa categorie + tinta de data. */
export function applyPrefsToEvents(prefs, { earlierDays, newLaterDays }) {
  return {
    earlierDays: earlierDays.filter((e) => categoryMatchesPrefs(e.category, prefs) && withinWindow(e.category, e.newDate, prefs)),
    newLaterDays: newLaterDays.filter((e) => categoryMatchesPrefs(e.category, prefs) && withinWindow(e.category, e.date, prefs)),
  };
}

const TOGGLE_KEYS = new Set(['teoretic', 'practic', 'obisnuit', 'urgent']);

/**
 * Inverseaza un flag dupa `path` ('teoretic'/'practic'/'obisnuit'/'urgent' sau 'loc:<id>').
 * Un path necunoscut (buton dintr-un mesaj vechi) intoarce prefs neschimbate, nu arunca.
 */
export function togglePref(prefs, path) {
  if (TOGGLE_KEYS.has(path)) return { ...prefs, [path]: !prefs[path] };
  if (path.startsWith('loc:')) {
    const loc = path.slice('loc:'.length);
    if (!(loc in prefs.locations)) return prefs;
    return { ...prefs, locations: { ...prefs.locations, [loc]: !prefs.locations[loc] } };
  }
  return prefs;
}

/**
 * Raspunsul la promptul "Pana la" / "Ultimul examen": "0"/"sterge" sterge valoarea, altfel
 * DD.MM.YYYY sau YYYY-MM-DD. Intoarce { ok, date } (date = "YYYY-MM-DD" sau null).
 */
export function parsePrefDateInput(text) {
  const v = text.trim();
  if (v === '0' || /^(sterge|șterge|clear)$/i.test(v)) return { ok: true, date: null };

  let year, month, day;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const human = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (iso) [, year, month, day] = iso;
  else if (human) [, day, month, year] = human;
  else return { ok: false };

  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  const valid =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 2024 && y <= 2100;
  if (!valid) return { ok: false };
  return { ok: true, date: `${year}-${month}-${day}` };
}

function toggleLabel(on, label) {
  return `${on ? '✅' : '❌'} ${label}`;
}

export function buildSettingsKeyboard(prefs) {
  return {
    inline_keyboard: [
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
      [
        {
          text: prefs.lastExam ? `🗓 Ultimul examen: ${formatDateHuman(prefs.lastExam)}` : '🗓 Ultimul examen: nesetat',
          callback_data: 'pref:lastexam',
        },
      ],
    ],
  };
}

export function buildSettingsSummary() {
  return [
    `⚙️ *${escapeMarkdownV2('Setările tale')}*`,
    '',
    escapeMarkdownV2('Apasă un buton ca să pornești/oprești. Doar ce e ✅ apare la /acum și în alertele automate. Filialele se aplică doar la practic. Cu „Până la" și/sau „Ultimul examen" setat, primești alertă pentru orice loc nou eliberat în acea fereastră, nu doar pentru cele mai devreme. „Ultimul examen" ascunde datele pe care nu le poți rezerva încă (teoretic: 5 zile, practic: 10 zile după examen).'),
  ].join('\n');
}

/** Linie de context pentru /acum cand exista o tinta de data; '' altfel. */
export function buildTargetNote(prefs) {
  const lines = [];
  if (prefs.lastExam) {
    const t = formatDateHuman(addDays(prefs.lastExam, MIN_GAP_DAYS.teoretic));
    const p = formatDateHuman(addDays(prefs.lastExam, MIN_GAP_DAYS.practic));
    lines.push(`🗓 ${escapeMarkdownV2(`După examenul din ${formatDateHuman(prefs.lastExam)}: teoretic de la ${t}, practic de la ${p}`)}`);
  }
  if (prefs.before) lines.push(`🎯 ${escapeMarkdownV2(`Doar date până la ${formatDateHuman(prefs.before)}`)}`);
  return lines.join('\n');
}

export const NO_CATEGORIES_MESSAGE = `⚠️ ${escapeMarkdownV2('Nu ai nicio categorie activă. Apasă /setari și alege ce vrei să urmărești.')}`;
