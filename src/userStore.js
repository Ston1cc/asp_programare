// Stocare per-chat pentru persoanele care NU sunt proprietarul botului -- fiecare isi da
// propriile date (IDNP/serie/data eliberarii) prin conversatie, ca sa poata interoga ASP
// in numele lor, nu al proprietarului. Backend: orice Redis standard (testat cu Redis
// Cloud), prin `redis` (client TCP oficial) -- NU o dependenta pe care o are si
// verificarea periodica (src/index.js), doar webhook-ul.
//
// Conexiunea e un singleton la nivel de modul, refolosit intre invocari cat timp
// instanta serverless ramane "calda" (Vercel Node functions pastreaza procesul intre
// cereri, spre deosebire de Edge runtime) -- deschidem o singura conexiune per instanta,
// nu una per request.
//
// Doua tipuri de inregistrari, ambele cu TTL ca sa nu se acumuleze la nesfarsit date
// personale ale unor straini:
//   person:<chatId>   -> { idnp, seriaAndNumber, issueDate } (JSON), TTL lung (90 zile)
//   pending:<chatId>  -> { step, idnp?, seriaAndNumber? } (JSON), TTL scurt (10 minute --
//                        daca cineva abandoneaza conversatia la jumatate, nu ramane blocat)

import { createClient } from 'redis';

const PERSON_TTL_SECONDS = 60 * 60 * 24 * 90;
const PENDING_TTL_SECONDS = 60 * 10;

let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error(
        'Lipseste REDIS_URL -- necesar pentru ca persoane in afara de proprietarul ' +
          'botului sa isi salveze datele.',
      );
    }
    const client = createClient({ url });
    client.on('error', (err) => console.error('Redis error:', err.message));
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

async function getJSON(key) {
  const client = await getClient();
  const raw = await client.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJSON(key, value, ttlSeconds) {
  const client = await getClient();
  await client.set(key, JSON.stringify(value), { EX: ttlSeconds });
}

async function del(key) {
  const client = await getClient();
  await client.del(key);
}

export async function getPerson(chatId) {
  return getJSON(`person:${chatId}`);
}

export async function setPerson(chatId, person) {
  await setJSON(`person:${chatId}`, person, PERSON_TTL_SECONDS);
}

export async function deletePerson(chatId) {
  await del(`person:${chatId}`);
}

export async function getPendingRegistration(chatId) {
  return getJSON(`pending:${chatId}`);
}

export async function setPendingRegistration(chatId, state) {
  await setJSON(`pending:${chatId}`, state, PENDING_TTL_SECONDS);
}

export async function clearPendingRegistration(chatId) {
  await del(`pending:${chatId}`);
}
