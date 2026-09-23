// Configurare + validare env. Nimic aici nu contine date personale ale userilor site-ului --
// doar CATEGORIILE monitorizate (publice) si citirea env-ului cu datele personale ale
// solicitantului (persoana care da examenul), necesare pentru a interoga API-ul ASP.

export const API_BASE = 'https://eservicii.gov.md/asp/dimtcca/api';

// ASP intoarce zile libere pe ~3 luni inainte -- 90 e orizontul folosit peste tot ca sa nu
// pierdem date reale (vezi filterWithinHorizon in format.js). Vechea varianta filtra doar
// pe "luna curenta + urmatoarea", ceea ce ascundea zile reale spre finalul orizontului
// (ex: o filiala practica ce are prima zi libera abia in noiembrie disparea complet din
// mesaje langa sfarsitul lui septembrie).
export const HORIZON_DAYS = 90;

// Toate locatiile monitorizate sunt in Chisinau -- folosit ca titlu generic in mesaje,
// filiala exacta apare in eticheta fiecarei categorii (vezi CATEGORIES mai jos).
export const CITY_NAME = 'Chișinău';

// Verificat live (21.09.2026): examenul TEORETIC la Chisinau se da doar la Salcamilor,
// dar examenul PRACTIC are 3 filiale distincte in Chisinau -- fiecare e un loc separat
// unde te poti prezenta, deci fiecare trebuie monitorizata individual.
// `short` = nume folosit in etichete si in sectiunea "cele mai apropiate date";
// `abbr` = abreviere scurta, folosita ca antet de coloana in tabelul monospace.
const LOCATIONS = {
  salcamilor: { id: 'salcamilor', name: 'DECA Chișinău (str. Salcâmilor, 28)', short: 'Salcâmilor 28', abbr: 'Salcâm.' },
  radautanu: { id: 'radautanu', name: 'DECA Chișinău (str. Acad. S. Rădăuțanu, 1)', short: 'Rădăuțanu 1', abbr: 'Rădău.' },
  ieasilor: { id: 'ieasilor', name: 'DECA Chișinău (str. Calea Ieșilor, 14)', short: 'Calea Ieșilor 14', abbr: 'Ieșil.' },
};

// Ruta pentru service ID difera intre teoretic si practic:
//   teoretic:  get-service/{TheoreticalExam|TheoreticalUrgentExam}/False
//   practic:   get-service/{PracticalExam|PracticalUrgentExam}/False/{categorie}
// Capcana verificata (22.09.2026, capturat din network tab-ul flow-ului APO01 real):
// urgenta NU e un flag boolean pe acelasi exam type -- e un exam type separat
// (`TheoreticalUrgentExam` / `PracticalUrgentExam`), iar al doilea segment e mereu
// `False` in ambele cazuri. Varianta veche (`TheoreticalExam/True`,
// `PracticalExam/True/...`) intoarce 200 cu un service ID valid dar GRESIT -- un
// serviciu diferit care intampla sa aiba acelasi calendar ca varianta obisnuita,
// nu serviciul urgent real (esec silentios, nu eroare). Verificat live ca serviciul
// urgent corect are intr-adevar date mai devreme decat obisnuit (uneori cu >1 saptamana).
// Capcana veche inca valabila: ruta practicului FARA segmentul de categorie intoarce 200
// cu service ID-ul teoretic (esec silentios) -- de asta path-ul e explicit per categorie,
// nu construit dinamic din bucati.
// `examType` + `urgent` -- folosite in format.js ca sa perecheze obisnuit/urgent per
// locatie fara sa parseze eticheta (fragil).
const BASE_CATEGORIES = [
  {
    key: 'teoretic-obisnuit',
    label: 'Teoretic obișnuit',
    emoji: '📗',
    examType: 'teoretic',
    urgent: false,
    servicePath: 'TheoreticalExam/False',
    locations: [LOCATIONS.salcamilor],
  },
  {
    key: 'teoretic-urgent',
    label: 'Teoretic urgent',
    emoji: '📕',
    examType: 'teoretic',
    urgent: true,
    servicePath: 'TheoreticalUrgentExam/False',
    locations: [LOCATIONS.salcamilor],
  },
  {
    key: 'practic-obisnuit',
    label: 'Practic obișnuit',
    emoji: '🚦',
    examType: 'practic',
    urgent: false,
    servicePath: 'PracticalExam/False/BMechanical',
    locations: [LOCATIONS.radautanu, LOCATIONS.ieasilor, LOCATIONS.salcamilor],
  },
  {
    key: 'practic-urgent',
    label: 'Practic urgent',
    emoji: '🚨',
    examType: 'practic',
    urgent: true,
    servicePath: 'PracticalUrgentExam/False/BMechanical',
    locations: [LOCATIONS.radautanu, LOCATIONS.ieasilor, LOCATIONS.salcamilor],
  },
];

// Fiecare (categorie, locatie) e monitorizat separat -- pentru categoriile teoretice
// exista o singura locatie, deci eticheta ramane simpla; pentru cele practice, cu 3
// filiale, eticheta include locatia ca sa fie clar unde anume s-a deschis ziua.
export const CATEGORIES = BASE_CATEGORIES.flatMap((cat) =>
  cat.locations.map((loc) => ({
    key: cat.locations.length > 1 ? `${cat.key}-${loc.id}` : cat.key,
    label: cat.locations.length > 1 ? `${cat.label} — ${loc.short}` : cat.label,
    emoji: cat.emoji,
    examType: cat.examType,
    urgent: cat.urgent,
    servicePath: cat.servicePath,
    locationName: loc.name,
    locationId: loc.id,
    locationShort: loc.short,
    locationAbbr: loc.abbr,
  })),
);

const REQUIRED_ENV = [
  'ASP_IDNP',
  'ASP_DOC_SERIES',
  'ASP_DOC_ISSUE_DATE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Lipsesc variabile de mediu obligatorii: ${missing.join(', ')}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(env.ASP_DOC_ISSUE_DATE)) {
    throw new Error(
      `ASP_DOC_ISSUE_DATE trebuie in format ISO "YYYY-MM-DDTHH:mm:ss", primit: "${env.ASP_DOC_ISSUE_DATE}"`,
    );
  }

  return {
    person: {
      idnp: env.ASP_IDNP,
      seriaAndNumber: env.ASP_DOC_SERIES,
      issueDate: env.ASP_DOC_ISSUE_DATE,
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    },
  };
}
