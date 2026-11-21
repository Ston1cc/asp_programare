// Statistici despre CAND apar locurile noi + cadenta adaptiva a verificarilor.
//
// Fiecare rulare a proprietarului stie ce zile s-au deschis (computeDiff). Le numaram pe ora
// locala (Europe/Chisinau) si pe ziua saptamanii, per tip de examen, in `state.stats` (se
// pastreaza in state/slots.json, comis in repo -> supravietuieste intre joburile din CI).
// Din orarul acesta calculam un program de verificari: mai des in orele in care se elibereaza
// de obicei locuri, mai rar in rest, in aceeasi cota zilnica ASP (`budget` cereri/zi).
//
// Pur: fara I/O. Datele sunt publice (zile libere), nimic personal.

import { escapeMarkdownV2, getLocalParts, formatDateHuman } from './format.js';

export const MIN_INTERVAL_SECONDS = 180; // nu mai des de 3 min, oricat de "fierbinte" e ora
export const MAX_INTERVAL_SECONDS = 1800; // nu mai rar de 30 min, oricat de "rece" e ora
// Plafon absolut: scripts/ci-loop.sh ignora valori peste 7200 s si ar reveni la cadenta fixa (mai deasa),
// deci nu producem niciodata mai mult, nici cand bugetul e prea mic pentru o rulare la 30 min.
export const HARD_MAX_INTERVAL_SECONDS = 7200;
export const MIN_SAMPLES = 20; // deschideri observate inainte sa folosim orarul (sub, cadenta fixa)
export const BUDGET_PER_IDNP = 160; // sub cota observata (~181-200), cu rezerva pentru /acum

const DOW_NAMES = ['Dum', 'Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm'];
const EXAM_TYPES = ['teoretic', 'practic'];

const zeros = (n) => Array.from({ length: n }, () => 0);

function emptyBucket() {
  return { hour: zeros(24), dow: zeros(7), openings: 0, days: 0 };
}

export function emptyStats(now = new Date()) {
  return { since: now.toISOString(), teoretic: emptyBucket(), practic: emptyBucket() };
}

/** Valideaza ce vine din exterior (state-ul postat de CI): intoarce stats curate sau null. */
export function sanitizeStats(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const since = typeof raw.since === 'string' && !Number.isNaN(Date.parse(raw.since)) ? raw.since : null;
  if (!since) return null;
  const arr = (a, n) =>
    Array.isArray(a) && a.length === n ? a.map((v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0)) : zeros(n);
  const out = { since };
  for (const type of EXAM_TYPES) {
    const b = raw[type] && typeof raw[type] === 'object' ? raw[type] : {};
    out[type] = {
      hour: arr(b.hour, 24),
      dow: arr(b.dow, 7),
      openings: Number.isFinite(b.openings) && b.openings >= 0 ? Math.round(b.openings) : 0,
      days: Number.isFinite(b.days) && b.days >= 0 ? Math.round(b.days) : 0,
    };
  }
  return out;
}

/** Valideaza programul primit din exterior ({ active, samples, runsPerDay, intervals }) sau null. */
export function sanitizeSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intervals =
    Array.isArray(raw.intervals) && raw.intervals.length === 24 && raw.intervals.every((v) => Number.isFinite(v) && v > 0)
      ? raw.intervals.map((v) => Math.round(v))
      : null;
  return {
    active: raw.active === true && intervals !== null,
    samples: Number.isFinite(raw.samples) ? Math.round(raw.samples) : 0,
    runsPerDay: Number.isFinite(raw.runsPerDay) ? Math.round(raw.runsPerDay) : 0,
    intervals,
  };
}

export function totalOpenings(stats) {
  return stats ? EXAM_TYPES.reduce((n, t) => n + (stats[t]?.openings ?? 0), 0) : 0;
}

function localDow(now) {
  const { year, month, day } = getLocalParts(now);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
}

/**
 * Adauga deschiderile din rularea curenta. `events` = { earlierDays, newLaterDays } din
 * computeDiff (inainte de filtrarea dupa preferinte); `ownerKeys` = categoriile citite la
 * cadenta proprietarului -- cele citite rar (doar pentru invitati) au o ora de detectie
 * imprecisa si nu se numara. O "deschidere" = o rulare in care a aparut cel putin o zi noua la
 * un tip de examen; `days` numara zilele noi. Intoarce stats noi (imutabil).
 */
export function recordOpenings(stats, events, ownerKeys, now = new Date()) {
  const base = sanitizeStats(stats) ?? emptyStats(now);
  const keys = new Set(ownerKeys);
  const perType = { teoretic: 0, practic: 0 };
  for (const e of events?.earlierDays ?? []) if (keys.has(e.category.key)) perType[e.category.examType] += 1;
  for (const e of events?.newLaterDays ?? []) if (keys.has(e.category.key)) perType[e.category.examType] += 1;
  if (perType.teoretic + perType.practic === 0) return base;

  const hour = getLocalParts(now).hour;
  const dow = localDow(now);
  const out = { since: base.since, teoretic: { ...base.teoretic }, practic: { ...base.practic } };
  for (const type of EXAM_TYPES) {
    if (perType[type] === 0) continue;
    const b = out[type];
    out[type] = {
      hour: b.hour.map((v, i) => (i === hour ? v + 1 : v)),
      dow: b.dow.map((v, i) => (i === dow ? v + 1 : v)),
      openings: b.openings + 1,
      days: b.days + perType[type],
    };
  }
  return out;
}

/** Deschideri pe fiecare ora (ambele tipuri de examen la un loc). */
export function openingsByHour(stats) {
  return zeros(24).map((_, h) => EXAM_TYPES.reduce((n, t) => n + (stats?.[t]?.hour?.[h] ?? 0), 0));
}

/**
 * Programul de verificari: cate secunde intre rulari, pe fiecare ora locala.
 *  - `budget`: cereri ASP pe zi disponibile (ambele IDNP-uri, cu rezerva)
 *  - `categoriesPerRun`: cate categorii costa o rulare (cereri/rulare, media)
 * Numarul de rulari/zi = budget / categoriesPerRun, impartit pe ore proportional cu deschiderile
 * observate (netezit, ca orele fara date sa nu ajunga la zero), apoi limitat la
 * [MIN_INTERVAL, MAX_INTERVAL] cu redistribuirea surplusului. Sub MIN_SAMPLES -> `active: false`.
 */
export function computeSchedule({ stats, budget, categoriesPerRun }) {
  const samples = totalOpenings(stats);
  const runsPerDay = Math.max(1, Math.floor(budget / Math.max(0.5, categoriesPerRun)));
  if (samples < MIN_SAMPLES) return { active: false, samples, runsPerDay, intervals: null };

  const byHour = openingsByHour(stats);
  const mean = samples / 24;
  const weights = byHour.map((n) => n + 0.5 * mean + 0.01);

  // Rulari/ora: proportional cu greutatea, limitat; surplusul/deficitul se redistribuie pe restul.
  const lo = Math.min(3600 / MAX_INTERVAL_SECONDS, runsPerDay / 24);
  const hi = 3600 / MIN_INTERVAL_SECONDS;
  const runs = new Array(24).fill(null);
  for (let iter = 0; iter < 24; iter++) {
    const free = runs.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
    if (free.length === 0) break;
    const remaining = runsPerDay - runs.reduce((n, v) => n + (v ?? 0), 0);
    const wsum = free.reduce((n, i) => n + weights[i], 0);
    let clamped = false;
    for (const i of free) {
      const v = (remaining * weights[i]) / wsum;
      if (v < lo) { runs[i] = lo; clamped = true; }
      else if (v > hi) { runs[i] = hi; clamped = true; }
    }
    if (!clamped) {
      for (const i of free) runs[i] = (remaining * weights[i]) / wsum;
      break;
    }
  }
  const intervals = runs.map((r) => Math.min(HARD_MAX_INTERVAL_SECONDS, Math.round(3600 / (r ?? lo))));
  return { active: true, samples, runsPerDay, intervals };
}

/** Intervalul (secunde) pana la urmatoarea rulare, dupa ora locala curenta; null daca programul nu e activ. */
export function intervalFor(schedule, now = new Date()) {
  if (!schedule?.active) return null;
  return schedule.intervals[getLocalParts(now).hour];
}

const pad2 = (n) => String(n).padStart(2, '0');

function bar(value, max, width = 12) {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width)));
}

function topHours(hourArr, n = 3) {
  return hourArr
    .map((count, h) => ({ h, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.h - b.h)
    .slice(0, n);
}

/** Mesajul pentru /statistici (MarkdownV2): cand apar locurile + cadenta curenta. */
export function buildStatsMessage({ stats, schedule, now = new Date(), nextIntervalSeconds = null }) {
  const lines = [`📈 *${escapeMarkdownV2('Statistici — când apar locurile')}*`, ''];
  const clean = sanitizeStats(stats);
  const samples = totalOpenings(clean);

  if (!clean || samples === 0) {
    lines.push(escapeMarkdownV2('Încă nu am observat nicio deschidere. Statisticile se adună din rulările automate.'));
    return lines.join('\n');
  }

  const days = Math.max(1, Math.ceil((now.getTime() - Date.parse(clean.since)) / 86_400_000));
  lines.push(escapeMarkdownV2(`Din ${formatDateHuman(clean.since.slice(0, 10))} (${days} zile) · ${samples} deschideri observate`));
  lines.push('');

  const byHour = openingsByHour(clean);
  const max = Math.max(...byHour);
  const chart = byHour.map((n, h) => `${pad2(h)}  ${bar(n, max).padEnd(12)} ${n}`).join('\n');
  lines.push(escapeMarkdownV2('Pe ore (ora locală):'));
  lines.push('```');
  lines.push(chart);
  lines.push('```');

  for (const type of EXAM_TYPES) {
    const b = clean[type];
    if (b.openings === 0) continue;
    const top = topHours(b.hour)
      .map((x) => `${pad2(x.h)}:00 (${x.count})`)
      .join(' · ');
    const dow = b.dow.map((n, i) => ({ n, name: DOW_NAMES[i] })).filter((x) => x.n > 0).sort((a, c) => c.n - a.n).slice(0, 3);
    lines.push('');
    lines.push(`*${escapeMarkdownV2(type === 'teoretic' ? 'Teoretic' : 'Practic')}* — ${escapeMarkdownV2(`${b.openings} deschideri, ${b.days} zile noi`)}`);
    lines.push(escapeMarkdownV2(`Ore active: ${top}`));
    if (dow.length > 0) lines.push(escapeMarkdownV2(`Zile: ${dow.map((x) => `${x.name} (${x.n})`).join(' · ')}`));
  }

  lines.push('');
  if (schedule?.active) {
    const ints = schedule.intervals;
    const fast = Math.min(...ints);
    const slow = Math.max(...ints);
    const hot = ints
      .map((s, h) => ({ s, h }))
      .sort((a, b) => a.s - b.s || a.h - b.h)
      .slice(0, 3)
      .map((x) => `${pad2(x.h)}:00 (${Math.round(x.s / 60)} min)`)
      .join(' · ');
    lines.push(`⏱ *${escapeMarkdownV2('Cadență adaptivă activă')}*`);
    lines.push(escapeMarkdownV2(`Între ${Math.round(fast / 60)} și ${Math.round(slow / 60)} min, ~${schedule.runsPerDay} rulări/zi în bugetul de cereri ASP.`));
    lines.push(escapeMarkdownV2(`Cel mai des: ${hot}`));
    if (nextIntervalSeconds) lines.push(escapeMarkdownV2(`Acum: la ~${Math.round(nextIntervalSeconds / 60)} min între verificări.`));
  } else {
    lines.push(`⏱ ${escapeMarkdownV2(`Cadență fixă încă: adun date (${samples}/${MIN_SAMPLES} deschideri) înainte să o fac adaptivă.`)}`);
  }
  return lines.join('\n');
}
