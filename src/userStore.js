// Stocare per-chat pentru persoanele care NU sunt proprietarul botului -- fiecare isi da
// propriile date (IDNP/serie/data eliberarii) prin conversatie, ca sa poata interoga ASP
// in numele lor, nu al proprietarului. Backend: Upstash Redis, prin REST API + fetch nativ
// (fara pachet npm, la fel ca restul proiectului -- vezi asp.js/telegram.js).
//
// Doua tipuri de inregistrari, ambele cu TTL ca sa nu se acumuleze la nesfarsit date
// personale ale unor straini:
//   person:<chatId>   -> { idnp, seriaAndNumber, issueDate } (JSON), TTL lung (90 zile)
//   pending:<chatId>  -> { step, idnp?, seriaAndNumber? } (JSON), TTL scurt (10 minute --
//                        daca cineva abandoneaza conversatia la jumatate, nu ramane blocat)

const PERSON_TTL_SECONDS = 60 * 60 * 24 * 90;
const PENDING_TTL_SECONDS = 60 * 10;

function upstashConfig(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      'Lipsesc UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN -- necesare pentru ca ' +
        'persoane in afara de proprietarul botului sa isi salveze datele.',
    );
  }
  return { url, token };
}

async function redisCommand(command) {
  const { url, token } = upstashConfig();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upstash ${command[0]}: HTTP ${res.status} -- ${body}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Upstash ${command[0]}: ${data.error}`);
  }
  return data.result;
}

async function getJSON(key) {
  const raw = await redisCommand(['GET', key]);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJSON(key, value, ttlSeconds) {
  await redisCommand(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
}

async function del(key) {
  await redisCommand(['DEL', key]);
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
