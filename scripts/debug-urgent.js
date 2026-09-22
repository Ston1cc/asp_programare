// Script de diagnostic, de rulat manual local (nu face parte din fluxul normal
// index.js / webhook). Compara, pentru fiecare (tip examen, locatie), varianta
// obisnuit vs urgent: acelasi service ID? aceeasi prima zi libera?
//
// Motiv: userul a confirmat ca pe eservicii.gov.md varianta "urgent" arata o data
// diferita (mai devreme) fata de "obisnuit", dar botul raporteaza aceeasi data la
// ambele -- deci undeva in lantul get-service -> qmatic/locations -> qmatic/dates
// urgenta nu ajunge sa conteze cu adevarat. Scriptul asta izoleaza fiecare pas ca sa
// se vada exact unde diverge (sau nu diverge, cand ar trebui) fata de ce arata site-ul.
//
// Rulare: node --env-file=.env scripts/debug-urgent.js

import { API_BASE, CATEGORIES, loadConfig } from '../src/config.js';

async function getServiceIdRaw(servicePath) {
  const url = `${API_BASE}/apo-request/get-service/${servicePath}`;
  const res = await fetch(url);
  const text = (await res.text()).trim();
  return { url, status: res.status, text };
}

async function getLocationIdRaw(serviceId, locationName) {
  const url = `${API_BASE}/qmatic/locations/${serviceId}`;
  const res = await fetch(url);
  const locations = await res.json().catch(() => null);
  const match = Array.isArray(locations) ? locations.find((loc) => loc.name === locationName) : null;
  return { url, status: res.status, locationsCount: Array.isArray(locations) ? locations.length : null, match };
}

async function getDatesRaw({ serviceId, locationId, person }) {
  const url = `${API_BASE}/qmatic/dates`;
  const body = {
    publicServiceId: serviceId,
    publicLocationId: locationId,
    idnp: person.idnp,
    seriaAndNumber: person.seriaAndNumber,
    issueDate: person.issueDate,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  const dates = await res.json().catch(() => null);
  return { url, status: res.status, dates: Array.isArray(dates) ? dates : null };
}

function groupKey(category) {
  return `${category.examType}::${category.locationId ?? ''}`;
}

async function inspectCategory(category, person) {
  const svc = await getServiceIdRaw(category.servicePath);
  if (svc.status !== 200) {
    return { category, error: `get-service HTTP ${svc.status}: ${svc.text.slice(0, 200)}` };
  }
  const serviceId = svc.text;

  const loc = await getLocationIdRaw(serviceId, category.locationName);
  if (loc.status !== 200 || !loc.match) {
    return {
      category,
      serviceId,
      error: `qmatic/locations HTTP ${loc.status}, gasit=${Boolean(loc.match)} din ${loc.locationsCount ?? '?'} locatii`,
    };
  }
  const locationId = loc.match.id;

  const datesRes = await getDatesRaw({ serviceId, locationId, person });
  if (datesRes.status !== 200 || !datesRes.dates) {
    return { category, serviceId, locationId, error: `qmatic/dates HTTP ${datesRes.status}` };
  }
  const sorted = [...datesRes.dates].sort((a, b) => a.date.localeCompare(b.date));

  return {
    category,
    serviceId,
    locationId,
    firstDate: sorted[0] ?? null,
    totalDays: sorted.length,
    raw: { servicePathUrl: svc.url, locationsUrl: loc.url, datesUrl: datesRes.url, datesBody: datesRes.dates },
  };
}

async function main() {
  const config = loadConfig();
  const groups = new Map();
  for (const category of CATEGORIES) {
    const key = groupKey(category);
    if (!groups.has(key)) groups.set(key, {});
    const slot = category.urgent ? 'urgent' : 'obisnuit';
    groups.get(key)[slot] = category;
  }

  console.log('='.repeat(80));
  console.log('Diagnostic obisnuit vs urgent -- per (tip examen, locatie)');
  console.log('='.repeat(80));

  for (const [key, { obisnuit, urgent }] of groups) {
    console.log(`\n### ${key}`);

    const [obRes, urRes] = await Promise.all([
      obisnuit ? inspectCategory(obisnuit, config.person) : null,
      urgent ? inspectCategory(urgent, config.person) : null,
    ]);

    for (const [label, res] of [['obisnuit', obRes], ['urgent', urRes]]) {
      if (!res) {
        console.log(`  ${label}: (nu exista in CATEGORIES pentru aceasta locatie)`);
        continue;
      }
      if (res.error) {
        console.log(`  ${label}: EROARE -- ${res.error}`);
        continue;
      }
      console.log(`  ${label}:`);
      console.log(`    servicePath   = ${res.category.servicePath}`);
      console.log(`    serviceId     = ${res.serviceId}`);
      console.log(`    locationId    = ${res.locationId}`);
      console.log(`    primaZi       = ${res.firstDate ? `${res.firstDate.date} (${res.firstDate.timeSlots} locuri)` : 'nicio zi'}`);
      console.log(`    totalZile     = ${res.totalDays}`);
    }

    if (obRes && urRes && !obRes.error && !urRes.error) {
      const sameServiceId = obRes.serviceId === urRes.serviceId;
      const sameFirstDate = obRes.firstDate?.date === urRes.firstDate?.date;
      console.log(`  => serviceId identic: ${sameServiceId ? 'DA (suspect -- get-service nu diferentiaza urgent/obisnuit)' : 'nu'}`);
      console.log(`  => prima zi identica: ${sameFirstDate ? 'da' : 'NU (diverg -- asta ar trebui sa se vada si in bot)'}`);
      if (sameServiceId) {
        console.log(`  => cerere qmatic/dates identica pentru ambele (acelasi serviceId+locationId), deci raspunsul e garantat identic.`);
        console.log(`     RAW get-service obisnuit: GET ${obRes.raw.servicePathUrl}`);
        console.log(`     RAW get-service urgent:   GET ${urRes.raw.servicePathUrl}`);
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('Trimite output-ul de mai sus inapoi -- in particular liniile "serviceId" si');
  console.log('"=> serviceId identic" pentru categoria unde ai vazut diferenta pe site.');
  console.log('='.repeat(80));
}

main().catch((err) => {
  console.error('Eroare fatala:', err);
  process.exitCode = 1;
});
