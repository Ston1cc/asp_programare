// Client pentru API-ul public ASP (eservicii.gov.md/asp/dimtcca).
// Descoperit prin inspectia live a fluxului APO01 (Chrome DevTools, Network tab).
// Trei apeluri per categorie: service ID -> location ID -> zile libere.
// Zero sesiune, zero cookie necesar, zero captcha -- pur read-only.

import { API_BASE } from './config.js';

const DEFAULT_RETRY_DELAYS_MS = [2000, 4000, 8000];
const DEFAULT_TIMEOUT_MS = 15_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP 429 de la ASP. Verificat live (24.09.2026): limita e o cota zilnica PER IDNP (acelasi
 * IP, alt IDNP -> raspuns normal), cu `Retry-After` pana la 23:59:59 UTC. Reincercarea nu
 * ajuta -- doar consuma cereri pe o cota deja epuizata -- deci nu se retry-uieste: apelantul
 * primeste `until` (Date) si opreste orice alta cerere pentru acel IDNP pana atunci.
 */
export class RateLimitError extends Error {
  constructor(label, until) {
    super(`${label}: HTTP 429 (limita ASP pana la ${until.toISOString()})`);
    this.name = 'RateLimitError';
    this.until = until;
  }
}

function parseRetryAfter(header, now = Date.now()) {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1000);
    const date = new Date(header);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/**
 * `fetchOptions` = { retryDelays, timeoutMs }, optional -- lasat implicit pentru
 * verificarea periodica (comportament neschimbat), suprascris de live.js cu valori mai
 * mici pentru raspunsul "/acum" (constrans de maxDuration: 30 pe Vercel, vezi
 * api/telegram-webhook.js). Fiecare incercare are timeout propriu (AbortSignal) -- fara
 * el, un fetch agatat ar bloca requestul pana la limita platformei, nu doar pana la
 * timeout-ul nostru.
 */
async function fetchWithRetry(url, options, label, fetchOptions = {}) {
  const { retryDelays = DEFAULT_RETRY_DELAYS_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = fetchOptions;
  let lastError;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429) {
        throw new RateLimitError(label, parseRetryAfter(res.headers.get('retry-after')));
      }
      if (!res.ok) {
        throw new Error(`${label}: HTTP ${res.status} la ${url}`);
      }
      return res;
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      lastError = err;
      if (attempt < retryDelays.length) {
        await sleep(retryDelays[attempt]);
      }
    }
  }
  throw new Error(`${label} a esuat dupa ${retryDelays.length + 1} incercari: ${lastError.message}`);
}

// `cache`, optional (un Map creat per-request de apelant) -- memoizeaza PROMISIUNEA (nu
// doar rezultatul), ca doua categorii care cer in paralel acelasi servicePath/serviceId
// sa nu declanseze doua fetch-uri identice. Doar 4 servicePath-uri distincte exista
// printre cele 8 categorii monitorizate (vezi config.js), deci fara cache /acum ar cere
// de doua ori acelasi service ID pentru fiecare pereche obisnuit/urgent pe 3 locatii.

async function getServiceId(servicePath, fetchOptions, cache) {
  const cacheKey = `service:${servicePath}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const promise = (async () => {
    const url = `${API_BASE}/apo-request/get-service/${servicePath}`;
    const res = await fetchWithRetry(url, undefined, `get-service/${servicePath}`, fetchOptions);
    const text = (await res.text()).trim();
    // Contract: raspunsul e un hash hex simplu, nu JSON. Daca site-ul incepe sa intoarca
    // JSON sau un mesaj de eroare deghizat in 200, hash-ul n-ar mai respecta formatul asta.
    if (!/^[a-f0-9]{40,80}$/i.test(text)) {
      throw new Error(`get-service/${servicePath}: raspuns neasteptat (nu pare service ID): "${text.slice(0, 100)}"`);
    }
    return text;
  })();
  if (cache) cache.set(cacheKey, promise);
  return promise;
}

async function getLocations(serviceId, fetchOptions, cache) {
  const cacheKey = `locations:${serviceId}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const promise = (async () => {
    const url = `${API_BASE}/qmatic/locations/${serviceId}`;
    const res = await fetchWithRetry(url, undefined, 'qmatic/locations', fetchOptions);
    const locations = await res.json();
    if (!Array.isArray(locations)) {
      throw new Error('qmatic/locations: raspuns neasteptat (nu e array)');
    }
    return locations;
  })();
  if (cache) cache.set(cacheKey, promise);
  return promise;
}

async function getLocationId(serviceId, locationName, fetchOptions, cache) {
  const locations = await getLocations(serviceId, fetchOptions, cache);
  const match = locations.find((loc) => loc.name === locationName);
  if (!match) {
    const names = locations.map((loc) => loc.name).join(', ');
    throw new Error(`qmatic/locations: "${locationName}" nu a fost gasita. Locatii disponibile: ${names}`);
  }
  return match.id;
}

async function getDates({ serviceId, locationId, person, fetchOptions }) {
  const url = `${API_BASE}/qmatic/dates`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        publicServiceId: serviceId,
        publicLocationId: locationId,
        idnp: person.idnp,
        seriaAndNumber: person.seriaAndNumber,
        issueDate: person.issueDate,
      }),
    },
    'qmatic/dates',
    fetchOptions,
  );
  const dates = await res.json();
  if (!Array.isArray(dates)) {
    throw new Error('qmatic/dates: raspuns neasteptat (nu e array) -- tratat ca esec, nu ca "zero locuri"');
  }
  // Fiecare element: { date: "YYYY-MM-DD", timeSlots: number|null, dateAsDateTime }
  return dates.map((d) => ({ date: d.date, timeSlots: d.timeSlots ?? null }));
}

/**
 * Interogheaza zilele libere pentru o categorie (categorie de examen + locatie specifica).
 * Arunca eroare in loc sa intoarca un rezultat gol daca oricare pas al lantului esueaza
 * sau are un contract neasteptat -- altfel o schimbare de API ar fi raportata gresit
 * ca "nu mai sunt locuri".
 *
 * `fetchOptions`/`cache` optionale -- vezi comentariile de mai sus; omise, comportamentul
 * e identic cu dinainte (folosit de src/index.js, verificarea periodica).
 */
export async function fetchCategoryDates(category, person, { fetchOptions, cache } = {}) {
  const serviceId = await getServiceId(category.servicePath, fetchOptions, cache);
  const locationId = await getLocationId(serviceId, category.locationName, fetchOptions, cache);
  const dates = await getDates({ serviceId, locationId, person, fetchOptions });
  return dates;
}
