// Persistenta + validare pentru utilizatorii inregistrati prin comanda "/inregistrare" de pe
// Telegram. Fiecare utilizator inregistrat e verificat separat pe ASP, cu propriile date
// (IDNP, serie buletin, data eliberare), si primeste alertele pe propriul chat -- nu doar
// persoana din .env (owner-ul), care continua sa functioneze neschimbat, fara inregistrare.
//
// Citirea/scrierea locala de aici (loadUsersLocal/saveUsersLocal) e folosita DOAR de
// src/index.js, care ruleaza pe un checkout real de git in GitHub Actions. Webhook-ul
// (api/telegram-webhook.js) nu are un checkout persistent intre invocari, deci citeste/scrie
// state/users.json direct prin GitHub Contents API -- vezi src/github-storage.js.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function emptyUsers() {
  return {};
}

export async function loadUsersLocal(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return emptyUsers();
    throw err;
  }
}

export async function saveUsersLocal(path, users) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(users, null, 2) + '\n', 'utf-8');
}

// IDNP moldovenesc: exact 13 cifre.
export function isValidIdnp(value) {
  return /^\d{13}$/.test(value);
}

// Seria buletinului: 2 litere + 7 cifre (ex. "EA0039316").
export function isValidSeria(value) {
  return /^[A-Za-z]{2}\d{7}$/.test(value);
}

// Data eliberarii, asa cum o introduce userul in conversatia de inregistrare: doar data
// ("AAAA-LL-ZZ"), fara ora -- ASP_DOC_ISSUE_DATE cere ora in ISO, dar in practica e mereu
// 00:00:00, deci n-are rost sa cerem asta de la un om care scrie de pe telefon.
// Verificarea de rotunjire (round-trip prin toISOString) respinge date calendaristice
// invalide gen "2025-02-30", pe care regex-ul singur nu le-ar prinde.
export function isValidIssueDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

export function toIssueDateIso(value) {
  return `${value}T00:00:00`;
}
