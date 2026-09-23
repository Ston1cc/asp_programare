// Formatare mesaje Telegram (MarkdownV2) + utilitare de date in fusul Europe/Chisinau.

import { CITY_NAME } from './config.js';

const TIMEZONE = 'Europe/Chisinau';
const TELEGRAM_MAX_LEN = 4096;

const DAY_NAMES = ['Dum', 'Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm'];
const MONTH_NAMES = [
  'ian', 'feb', 'mar', 'apr', 'mai', 'iun',
  'iul', 'aug', 'sept', 'oct', 'noi', 'dec',
];

// MarkdownV2 cere escape pe orice caracter din lista de mai jos, oriunde apare in text
// (nu doar in markup) -- altfel Telegram raspunde 400 Bad Request. Numele locatiei
// contine "." si paranteze, deci fara escape mesajul ar pica mereu.
const MARKDOWN_V2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text) {
  return String(text).replace(MARKDOWN_V2_SPECIAL, (ch) => `\\${ch}`);
}

/** Returneaza { year, month, day, hour, minute } pentru "now" in Europe/Chisinau. */
export function getLocalParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  // "hour" poate iesi "24" la miezul noptii in unele medii ICU -- normalizam la 0.
  const hour = Number(parts.hour) % 24;
  return { year: parts.year, month: parts.month, day: parts.day, hour, minute: Number(parts.minute) };
}

export function getLocalDateString(now = new Date()) {
  const { year, month, day } = getLocalParts(now);
  return `${year}-${month}-${day}`;
}

/** Filtreaza datele "YYYY-MM-DD" la luna curenta + urmatoarea, calculate in Europe/Chisinau. */
export function filterCurrentAndNextMonth(dates, now = new Date()) {
  const { year, month } = getLocalParts(now);
  const y = Number(year);
  const m = Number(month); // 1-12
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const curPrefix = `${y}-${String(m).padStart(2, '0')}`;
  const nextPrefix = `${nextY}-${String(nextM).padStart(2, '0')}`;
  return dates.filter((d) => d.date.startsWith(curPrefix) || d.date.startsWith(nextPrefix));
}

function dateParts(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { y, m, d };
}

function dayOfWeek(dateStr) {
  const { y, m, d } = dateParts(dateStr);
  // Data e o zi de calendar (fara ora), deci UTC e sigur pentru a afla ziua saptamanii.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "2026-10-15" -> "Joi 15 oct". */
export function formatDateHuman(dateStr) {
  const { m, d } = dateParts(dateStr);
  return `${DAY_NAMES[dayOfWeek(dateStr)]} ${d} ${MONTH_NAMES[m - 1]}`;
}

/** "2026-10-15" -> "Joi 15.10" -- format compact, folosit in tabelul monospace. */
export function formatDateCompact(dateStr) {
  const { m, d } = dateParts(dateStr);
  return `${DAY_NAMES[dayOfWeek(dateStr)]} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

/** Numar de zile calendaristice intre "azi" (Europe/Chisinau) si dateStr. */
export function daysUntil(dateStr, now = new Date()) {
  const todayStr = getLocalDateString(now);
  const { y: ty, m: tm, d: td } = dateParts(todayStr);
  const { y: dy, m: dm, d: dd } = dateParts(dateStr);
  const today = Date.UTC(ty, tm - 1, td);
  const target = Date.UTC(dy, dm - 1, dd);
  return Math.round((target - today) / 86_400_000);
}

const DIVIDER = '────────────';

// Gramatica romana: numerele >= 20 cer "de" inaintea substantivului numarat
// ("24 de zile", "20 de locuri"), cele sub 20 nu ("19 zile", "1 loc").
function withDe(n, singular, plural) {
  const noun = n === 1 ? singular : plural;
  return n >= 20 ? `${n} de ${noun}` : `${n} ${noun}`;
}

export function slotsLabel(timeSlots) {
  if (timeSlots == null) return '— neafișat încă';
  return `— ${withDe(timeSlots, 'loc', 'locuri')}`;
}

/** Ca slotsLabel, dar fara liniuta -- pentru linii care deja au un separator "·". */
export function plainSlotsLabel(timeSlots) {
  if (timeSlots == null) return 'neafișat încă';
  return withDe(timeSlots, 'loc', 'locuri');
}

export function daysWord(n) {
  return withDe(n, 'zi', 'zile');
}

function sortByDate(dates) {
  return [...dates].sort((a, b) => a.date.localeCompare(b.date));
}

// --- Gruparea obisnuit/urgent per (tip examen, locatie) ---------------------------
//
// Gruparea perecheaza obisnuit + urgent ca sa poata fi afisate impreuna (unul sub altul,
// per locatie), fara sa ascunda vreo varianta -- userul vrea explicit sa vada ambele
// date, chiar daca in practica coincid. Cheia de grupare foloseste `examType`+
// `locationId` din config.js, nu parsare de text din eticheta.

function groupKey(category) {
  return `${category.examType}::${category.locationId ?? ''}`;
}

/**
 * Grupeaza categoryResults (fiecare = { category, dates }) pe (tip examen, locatie),
 * perechind obisnuit + urgent. `display` = setul de date folosit in sectiunile care
 * arata o singura varianta (lista completa, tabelul practic) -- preferă obisnuit,
 * cade pe urgent daca obisnuit a esuat la citire.
 */
function groupCategoryResults(categoryResults) {
  const map = new Map();
  for (const cr of categoryResults) {
    const key = groupKey(cr.category);
    if (!map.has(key)) {
      map.set(key, {
        examType: cr.category.examType,
        emoji: cr.category.emoji,
        locationShort: cr.category.locationShort,
        locationAbbr: cr.category.locationAbbr,
        locationId: cr.category.locationId,
        obisnuit: null,
        urgent: null,
      });
    }
    const g = map.get(key);
    if (cr.category.urgent) g.urgent = cr;
    else g.obisnuit = cr;
  }
  return [...map.values()].map((g) => ({ ...g, display: g.obisnuit ?? g.urgent }));
}

// --- Sectiunea "Cele mai apropiate date" -------------------------------------------

// Fiecare bucata e escapata individual, iar marcajele *bold*/_italic_ se adauga DUPA
// escapare -- daca am escapa linia intreaga dintr-o data, escapeMarkdownV2 ar transforma
// si asteriscurile de markup in text literal, stricand formatarea.
function closestLineText(dates, now, { withLocation, withDays }) {
  const sorted = sortByDate(dates);
  if (sorted.length === 0) return `_${escapeMarkdownV2('fără zile libere')}_`;
  const first = sorted[0];
  const parts = [`*${escapeMarkdownV2(formatDateHuman(first.date))}*`];
  if (withLocation) parts.push(escapeMarkdownV2(withLocation));
  parts.push(escapeMarkdownV2(plainSlotsLabel(first.timeSlots)));
  if (withDays) parts.push(escapeMarkdownV2(`peste ${daysWord(daysUntil(first.date, now))}`));
  return parts.join(' · ');
}

// Arata mereu ambele variante, obisnuit si urgent, fiecare pe randul ei -- chiar daca
// in practica au aceleasi date, userul vrea sa vada explicit ambele, nu doar una.
function closestLinesForGroup(g, now, { withLocation, withDays }) {
  const loc = withLocation ? g.locationShort : null;
  const lines = [];
  if (g.obisnuit) {
    lines.push(`${closestLineText(g.obisnuit.dates, now, { withLocation: loc, withDays })} ${escapeMarkdownV2('(obișnuit)')}`);
  }
  if (g.urgent) {
    lines.push(`${closestLineText(g.urgent.dates, now, { withLocation: loc, withDays })} ${escapeMarkdownV2('(urgent)')}`);
  }
  return lines;
}

function buildClosestDatesLines(groups, now) {
  const lines = [];
  const teoretic = groups.filter((g) => g.examType === 'teoretic');
  const practic = groups
    .filter((g) => g.examType === 'practic')
    .sort((a, b) => (sortByDate(a.display.dates)[0]?.date ?? '9999').localeCompare(sortByDate(b.display.dates)[0]?.date ?? '9999'));

  if (teoretic.length > 0) {
    lines.push(`📗 *${escapeMarkdownV2('Teoretic')}*`);
    for (const g of teoretic) lines.push(...closestLinesForGroup(g, now, { withLocation: false, withDays: true }));
    lines.push('');
  }
  if (practic.length > 0) {
    lines.push(`🚦 *${escapeMarkdownV2('Practic')}*`);
    for (const g of practic) lines.push(...closestLinesForGroup(g, now, { withLocation: true, withDays: false }));
  }
  return lines;
}

// --- Sectiunea "Cele mai apropiate date", varianta compacta pentru mesajul LIVE ---
//
// Un singur format de linie, mereu -- indiferent daca obisnuit si urgent cad pe aceeasi
// zi, pe zile diferite, sau daca unul dintre ei n-are nicio zi libera. O versiune mai
// veche colapsa cele doua variante intr-un rand comun cand coincideau, si le compara pe
// un rand separat, fara zile-pana-la/locuri, cand divergeau -- trei forme diferite de
// citit in acelasi mesaj (semnalat de user dupa un audit de securitate care a atins si
// codul asta). Acum fiecare varianta (obisnuit/urgent) e mereu propriul rand, cu aceeasi
// structura: `eticheta: **data** · peste N zile · X locuri` (sau "fără zile libere").
// Locatia (doar pentru practic) e mereu un rand-antet separat, bold, niciodata inline pe
// randul unei variante -- elimina ambiguitatea "de ce apare uneori pe randul datei, alteori
// deasupra". Zilele cu putine locuri primesc un semnal ⚠️, ca sa sara in ochi fara sa cauti
// prin mesaj.

const LOW_SLOTS_THRESHOLD = 2;

function slotsWithWarning(timeSlots) {
  const label = plainSlotsLabel(timeSlots);
  return timeSlots != null && timeSlots <= LOW_SLOTS_THRESHOLD ? `⚠️ ${label}` : label;
}

/** O linie completa pentru o singura varianta (obisnuit SAU urgent) -- vezi comentariul de mai sus. */
function liveVariantLine(label, entry, now) {
  const labelText = escapeMarkdownV2(`${label}:`);
  if (!entry) {
    return `${labelText} ${escapeMarkdownV2('fără zile libere')}`;
  }
  const parts = [
    `*${escapeMarkdownV2(formatDateHuman(entry.date))}*`,
    escapeMarkdownV2(`peste ${daysWord(daysUntil(entry.date, now))}`),
    slotsWithWarning(entry.timeSlots),
  ];
  return `${labelText} ${parts.join(' · ')}`;
}

function liveGroupLines(g, now, { withLocation }) {
  const obisnuitFirst = g.obisnuit ? sortByDate(g.obisnuit.dates)[0] ?? null : null;
  const urgentFirst = g.urgent ? sortByDate(g.urgent.dates)[0] ?? null : null;

  const lines = [];
  if (withLocation) lines.push(`*${escapeMarkdownV2(g.locationShort)}*`);
  const indent = withLocation ? '   ' : '';
  // Randul apare doar daca varianta a fost citita cu succes de data asta (g.obisnuit/
  // g.urgent) -- o citire esuata nu genereaza un rand fals "fără zile libere", ci lipseste
  // complet (avertismentul agregat "N/8 categorii n-au putut fi citite" acopera cazul).
  if (g.obisnuit) lines.push(`${indent}${liveVariantLine('obișnuit', obisnuitFirst, now)}`);
  if (g.urgent) lines.push(`${indent}${liveVariantLine('urgent', urgentFirst, now)}`);
  return lines;
}

function earliestOverall(g) {
  const a = g.obisnuit ? sortByDate(g.obisnuit.dates)[0]?.date : null;
  const b = g.urgent ? sortByDate(g.urgent.dates)[0]?.date : null;
  if (a && b) return a < b ? a : b;
  return a ?? b ?? '9999-99-99';
}

function buildLiveClosestLines(groups, now) {
  const lines = [];
  const teoretic = groups.filter((g) => g.examType === 'teoretic');
  const practic = groups
    .filter((g) => g.examType === 'practic')
    .sort((a, b) => earliestOverall(a).localeCompare(earliestOverall(b)));

  if (teoretic.length > 0) {
    lines.push(`📗 *${escapeMarkdownV2('Teoretic')}*`);
    for (const g of teoretic) {
      lines.push(...liveGroupLines(g, now, { withLocation: false }));
      lines.push('');
    }
  }
  if (practic.length > 0) {
    lines.push(`🚦 *${escapeMarkdownV2('Practic')}*`);
    for (const g of practic) {
      lines.push(...liveGroupLines(g, now, { withLocation: true }));
      lines.push('');
    }
  }
  return lines;
}

// --- Compactare in intervale pentru lista completa a unei singure locatii ----------

/** Grupeaza zile consecutive (in lista, nu neaparat calendaristic) cu acelasi numar de locuri. */
export function buildDateRanges(dates) {
  const sorted = sortByDate(dates);
  const ranges = [];
  for (const d of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.timeSlots === d.timeSlots) {
      last.end = d.date;
    } else {
      ranges.push({ start: d.date, end: d.date, timeSlots: d.timeSlots });
    }
  }
  return ranges;
}

export function formatRangeLabel(range) {
  const start = dateParts(range.start);
  const end = dateParts(range.end);
  const isSingleDay = range.start === range.end;
  const dateText = isSingleDay
    ? `${start.d} ${MONTH_NAMES[start.m - 1]}`
    : start.m === end.m
      ? `${start.d}–${end.d} ${MONTH_NAMES[end.m - 1]}`
      : `${start.d} ${MONTH_NAMES[start.m - 1]}–${end.d} ${MONTH_NAMES[end.m - 1]}`;
  const countText =
    range.timeSlots == null
      ? 'neafișat încă'
      : isSingleDay
        ? withDe(range.timeSlots, 'loc', 'locuri')
        : `${withDe(range.timeSlots, 'loc', 'locuri')}/zi`;
  return `${dateText}: ${countText}`;
}

// --- Tabel monospace: zile x filiale, pentru proba practica ------------------------

/**
 * `-` = filiala nu are deschisa acea zi; `?` = zi deschisa dar nr. de locuri neafisat.
 * Randat intr-un bloc ``` ``` -- Telegram pastreaza spatiile, deci coloanele raman
 * aliniate doar daca folosim un font monospace (garantat de blocul de cod).
 */
export function buildPracticTable(practicGroups) {
  const dateSet = new Set();
  for (const g of practicGroups) {
    for (const d of g.display?.dates ?? []) dateSet.add(d.date);
  }
  const dates = [...dateSet].sort();
  if (dates.length === 0) return null;

  const dateColWidth = Math.max('Data'.length, ...dates.map((d) => formatDateCompact(d).length));
  const colWidths = practicGroups.map((g) => Math.max(g.locationAbbr.length, 1));

  const header = [
    'Data'.padEnd(dateColWidth),
    ...practicGroups.map((g, i) => g.locationAbbr.padEnd(colWidths[i])),
  ].join(' ');

  const rows = dates.map((date) => {
    const cells = practicGroups.map((g, i) => {
      const entry = g.display?.dates.find((d) => d.date === date);
      const text = !entry ? '-' : entry.timeSlots == null ? '?' : String(entry.timeSlots);
      return text.padStart(colWidths[i]);
    });
    return [formatDateCompact(date).padEnd(dateColWidth), ...cells].join(' ');
  });

  return [header, ...rows].join('\n');
}

/**
 * Mesaj de alerta pentru evenimente noi. earlierDays (categorii unde a scazut minimul)
 * apar intr-un bloc unic 🔥 in capul mesajului -- cel mai important semnal, motiv pentru
 * care exista monitorul. newLaterDays (zile noi, dar nu recorduri) apar dedesubt, separate
 * printr-un divider, ca sa nu se piarda in aceeasi masa de text.
 */
export function buildAlertMessage({ earlierDays, newLaterDays }) {
  if (earlierDays.length === 0 && newLaterDays.length === 0) return null;

  const lines = [];

  if (earlierDays.length > 0) {
    lines.push(`🔥 *${escapeMarkdownV2('S-a deschis o zi mai devreme!')}*`);
    lines.push(`📍 ${escapeMarkdownV2(CITY_NAME)}`);
    lines.push('');
    for (const ev of earlierDays) {
      lines.push(`${ev.category.emoji} *${escapeMarkdownV2(ev.category.label)}*`);
      lines.push(
        `   ${escapeMarkdownV2(formatDateHuman(ev.newDate))} ${escapeMarkdownV2(slotsLabel(ev.newTimeSlots))}`,
      );
      if (ev.prevDate) {
        const gained = daysUntil(ev.prevDate) - daysUntil(ev.newDate);
        lines.push(escapeMarkdownV2(`   ↳ era ${formatDateHuman(ev.prevDate)} · cu ${daysWord(gained)} mai devreme`));
      } else {
        lines.push(escapeMarkdownV2('   ↳ înainte nu erau zile libere'));
      }
      lines.push('');
    }
  }

  if (newLaterDays.length > 0) {
    if (earlierDays.length > 0) {
      lines.push(escapeMarkdownV2(DIVIDER));
      lines.push('*Alte zile noi \\(nu sunt cele mai devreme\\):*');
    } else {
      lines.push(`🚗 *Zile noi*`);
      lines.push(`📍 ${escapeMarkdownV2(CITY_NAME)}`);
    }
    lines.push('');
    const byCategory = groupBy(newLaterDays, (d) => d.category.key);
    for (const [, items] of byCategory) {
      const { category } = items[0];
      lines.push(`${category.emoji} *${escapeMarkdownV2(category.label)}*`);
      for (const item of items) {
        lines.push(`  • ${escapeMarkdownV2(formatDateHuman(item.date))} ${escapeMarkdownV2(slotsLabel(item.timeSlots))}`);
      }
    }
  }

  return lines.join('\n').trim();
}

/**
 * Rezumat zilnic (heartbeat) sau rezumat de pornire (prima rulare vreodata). Structura:
 *  1. Cele mai apropiate date, per tip de examen (grupate, cu practic sortat dupa data)
 *  2. Teoretic: toate zilele, compactate in intervale ("15–23 oct: 7 locuri/zi")
 *  3. Practic: tabel monospace zile x filiale (Telegram nu randeaza tabele Markdown,
 *     dar respecta spatiile intr-un bloc de cod, deci un tabel text simplu functioneaza)
 */
export function buildHeartbeatMessage({ categoryResults, now = new Date(), title = null }) {
  const groups = groupCategoryResults(categoryResults);
  const lines = [];

  const { day, month, hour } = getLocalParts(now);
  const heading = title
    ? `📅 *${escapeMarkdownV2(title)}*`
    : `📅 *${escapeMarkdownV2(`Situație ${Number(day)} ${MONTH_NAMES[Number(month) - 1]}, ${String(hour).padStart(2, '0')}:00`)}*`;
  lines.push(heading);
  lines.push(`📍 ${escapeMarkdownV2(CITY_NAME)}`);
  lines.push('');

  lines.push(`⚡ *${escapeMarkdownV2('Cele mai apropiate date')}*`);
  lines.push('');
  lines.push(...buildClosestDatesLines(groups, now));

  lines.push('');
  lines.push(escapeMarkdownV2(DIVIDER));

  const teoreticGroup = groups.find((g) => g.examType === 'teoretic');
  if (teoreticGroup && teoreticGroup.display.dates.length > 0) {
    lines.push(`📗 *${escapeMarkdownV2('Teoretic, toate zilele')}*`);
    for (const range of buildDateRanges(teoreticGroup.display.dates)) {
      lines.push(escapeMarkdownV2(formatRangeLabel(range)));
    }
    lines.push('');
  }

  const practicGroups = groups.filter((g) => g.examType === 'practic');
  if (practicGroups.length > 0) {
    lines.push(`🚦 *${escapeMarkdownV2('Practic, locuri pe zi')}*`);
    const table = buildPracticTable(practicGroups);
    if (table) {
      lines.push('```');
      lines.push(table);
      lines.push('```');
      lines.push(escapeMarkdownV2('-  = nicio dată afișată'));
      lines.push(escapeMarkdownV2('?  = neafișat încă'));
    } else {
      lines.push(escapeMarkdownV2('fără zile libere'));
    }
  }

  return lines.join('\n').trim();
}

/**
 * Raspuns la comanda "/acum" -- verificare LIVE la cerere, nu din state. Doar sectiunea
 * "cele mai apropiate date" (nu toata lista/tabelul) ca raspunsul sa fie scurt si citit
 * rapid pe telefon; detaliul complet oricum vine automat la heartbeat-ul zilnic.
 */
export function buildLiveNowMessage({ categoryResults, now = new Date() }) {
  const groups = groupCategoryResults(categoryResults);
  const { day, month, hour, minute } = getLocalParts(now);
  const timeText = `verificat ${Number(day)} ${MONTH_NAMES[Number(month) - 1]}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const lines = [];
  lines.push(`🔴 *${escapeMarkdownV2(`LIVE · ${timeText}`)}*`);
  lines.push(`📍 ${escapeMarkdownV2(CITY_NAME)}`);
  lines.push('');
  lines.push(...buildLiveClosestLines(groups, now));
  return lines.join('\n').trim();
}

export function buildFailureMessage(errorsByCategory) {
  const lines = ['⚠️ *Monitorul ASP nu poate citi calendarul*', ''];
  lines.push(escapeMarkdownV2('3 rulări la rând au eșuat pentru:'));
  for (const [label, message] of errorsByCategory) {
    lines.push(`• ${escapeMarkdownV2(label)}: ${escapeMarkdownV2(message)}`);
  }
  lines.push('');
  lines.push(escapeMarkdownV2('Verifică manual pe eservicii.gov.md — probabil site-ul și-a schimbat structura.'));
  return lines.join('\n');
}

/** Sparge un mesaj lung pe granite de linie, sub limita Telegram. */
export function splitMessage(text, maxLen = TELEGRAM_MAX_LEN) {
  if (text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxLen) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}
