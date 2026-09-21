// Client pentru API-ul public ASP (eservicii.gov.md/asp/dimtcca).
// Descoperit prin inspectia live a fluxului APO01 (Chrome DevTools, Network tab).
// Trei apeluri per categorie: service ID -> location ID -> zile libere.
// Zero sesiune, zero cookie necesar, zero captcha -- pur read-only.

import { API_BASE } from './config.js';

const RETRY_DELAYS_MS = [2000, 4000, 8000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, label) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) {
        throw new Error(`${label}: HTTP ${res.status} la ${url}`);
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw new Error(`${label} a esuat dupa ${RETRY_DELAYS_MS.length + 1} incercari: ${lastError.message}`);
}

async function getServiceId(servicePath) {
  const url = `${API_BASE}/apo-request/get-service/${servicePath}`;
  const res = await fetchWithRetry(url, undefined, `get-service/${servicePath}`);
  const text = (await res.text()).trim();
  // Contract: raspunsul e un hash hex simplu, nu JSON. Daca site-ul incepe sa intoarca
  // JSON sau un mesaj de eroare deghizat in 200, hash-ul n-ar mai respecta formatul asta.
  if (!/^[a-f0-9]{40,80}$/i.test(text)) {
    throw new Error(`get-service/${servicePath}: raspuns neasteptat (nu pare service ID): "${text.slice(0, 100)}"`);
  }
  return text;
}

async function getLocationId(serviceId, locationName) {
  const url = `${API_BASE}/qmatic/locations/${serviceId}`;
  const res = await fetchWithRetry(url, undefined, 'qmatic/locations');
  const locations = await res.json();
  if (!Array.isArray(locations)) {
    throw new Error('qmatic/locations: raspuns neasteptat (nu e array)');
  }
  const match = locations.find((loc) => loc.name === locationName);
  if (!match) {
    const names = locations.map((loc) => loc.name).join(', ');
    throw new Error(`qmatic/locations: "${locationName}" nu a fost gasita. Locatii disponibile: ${names}`);
  }
  return match.id;
}

async function getDates({ serviceId, locationId, person }) {
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
 */
export async function fetchCategoryDates(category, person) {
  const serviceId = await getServiceId(category.servicePath);
  const locationId = await getLocationId(serviceId, category.locationName);
  const dates = await getDates({ serviceId, locationId, person });
  return dates;
}
