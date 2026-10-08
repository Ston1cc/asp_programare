// Stocare per-chat pentru persoanele care NU sunt proprietarul botului -- fiecare isi da
// propriile date (IDNP/serie/data eliberarii) prin conversatie, ca sa poata interoga ASP
// in numele lor, nu al proprietarului. Backend: orice Redis standard (testat cu Redis
// Cloud), prin `redis` (client TCP oficial) -- NU o dependenta pe care o are si
// verificarea periodica (src/index.js), doar webhook-ul.
//
// Conexiunea e un singleton la nivel de modul, refolosit intre invocari cat timp
// instanta serverless ramane "calda" (Vercel Node functions pastreaza procesul intre
// cereri, spre deosebire de Edge runtime) -- deschidem o singura conexiune per instanta,
// nu una per request. Daca `connect()` esueaza, `clientPromise` e resetat la null ca
// urmatorul apel sa poata reincerca -- altfel o promisiune respinsa ar ramane in cache
// pana moare instanta, iar orice comanda ulterioara ar esua instant fara sa mai incerce.
//
// Trei tipuri de inregistrari, toate cu TTL ca sa nu se acumuleze la nesfarsit date
// personale ale unor straini:
//   person:<chatId>   -> { idnp, seriaAndNumber, issueDate } (criptat), 90 zile
//   pending:<chatId>  -> { step, idnp?, seriaAndNumber? } (criptat), 10 minute -- daca
//                        cineva abandoneaza conversatia la jumatate, nu ramane blocat
//   access:<chatId>   -> { status: 'pending'|'approved'|'denied', name, username,
//                        requestedAt } (criptat) -- cererea unui chat strain de a folosi
//                        botul, aprobata/respinsa manual de proprietar (vezi CLAUDE.md)
//
// Criptare: orice JSON scris prin setJSON/getJSON e cifrat AES-256-GCM cu USER_DATA_KEY
// (32 bytes, base64, separata de REDIS_URL) inainte sa ajunga in Redis -- cine are doar
// connection string-ul Redis nu poate citi datele. Un record cu format necunoscut/vechi
// (in clar, dinainte de aceasta schimbare) e tratat ca inexistent, nu ca eroare.

import { createClient } from 'redis';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

const PERSON_TTL_SECONDS = 60 * 60 * 24 * 90;
const PENDING_TTL_SECONDS = 60 * 10;
const ACCESS_REQUEST_TTL_SECONDS = 60 * 60 * 24 * 30;
const ACCESS_DENIED_TTL_SECONDS = 60 * 60 * 24 * 30;
const ACCESS_APPROVED_TTL_SECONDS = 60 * 60 * 24 * 90;

// Rate-limit per chat (protejeaza useri unii de altii -- vezi CLAUDE.md, cooldown-ul
// vechi era global si nedrept intre useri diferiti) si global (protejeaza ASP de volum
// total daca mai multi useri verifica simultan). Folosesc chei simple Redis, nu JSON --
// nu contin date personale, deci nu trec prin criptare.
const RATE_LIMIT_CHAT_WINDOW_SECONDS = 45;
const RATE_LIMIT_GLOBAL_WINDOW_SECONDS = 60;
const RATE_LIMIT_GLOBAL_MAX = 10;

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
    const client = createClient({
      url,
      socket: {
        connectTimeout: 5000,
        // Renunta rapid in loc sa tina un request Telegram agatat pana la timeout-ul
        // functiei -- webhook-ul are oricum un mesaj de fallback ("indisponibil") cand
        // Redis pica.
        reconnectStrategy: (retries) => (retries > 2 ? new Error('Redis indisponibil dupa 3 incercari') : retries * 300),
      },
    });
    client.on('error', (err) => console.error('Redis error:', err.message));
    clientPromise = client.connect().then(
      () => client,
      (err) => {
        clientPromise = null;
        throw err;
      },
    );
  }
  return clientPromise;
}

// --- Criptare AES-256-GCM ------------------------------------------------------------

let cachedKey = null;
function getEncryptionKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.USER_DATA_KEY;
  if (!raw) {
    throw new Error('Lipseste USER_DATA_KEY -- necesara pentru criptarea datelor personale in Redis.');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`USER_DATA_KEY trebuie sa fie 32 bytes in base64 (are ${key.length}).`);
  }
  cachedKey = key;
  return key;
}

function encrypt(value) {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Intoarce null pentru orice record ilizibil (format vechi/necunoscut, cheie gresita, coruptie) -- tratat ca inexistent, nu ca eroare fatala. */
function decrypt(raw) {
  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const key = getEncryptionKey();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (err) {
    console.error('Eroare la decriptare (tratat ca inexistent):', err.message);
    return null;
  }
}

async function getJSON(key) {
  const client = await getClient();
  const raw = await client.get(key);
  if (raw == null) return null;
  return decrypt(raw);
}

async function setJSON(key, value, ttlSeconds) {
  const client = await getClient();
  await client.set(key, encrypt(value), { EX: ttlSeconds });
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

// --- Acces: cererea unui chat strain de a folosi botul, aprobata manual de proprietar --

export async function getAccess(chatId) {
  return getJSON(`access:${chatId}`);
}

/**
 * Creeaza cererea de acces DOAR daca nu exista deja un record (SET NX) -- altfel un
 * strain ar putea bombarda proprietarul cu notificari repetate doar retrimitand acelasi
 * mesaj. Intoarce true daca s-a creat acum (deci merita notificat proprietarul), false
 * daca exista deja un record (pending/approved/denied).
 */
export async function requestAccessIfNew(chatId, meta) {
  const client = await getClient();
  const value = encrypt({ status: 'pending', ...meta, requestedAt: new Date().toISOString() });
  const created = await client.set(`access:${chatId}`, value, { EX: ACCESS_REQUEST_TTL_SECONDS, NX: true });
  return created === 'OK';
}

export async function setAccessStatus(chatId, status) {
  const ttl = status === 'approved' ? ACCESS_APPROVED_TTL_SECONDS : ACCESS_DENIED_TTL_SECONDS;
  const existing = (await getAccess(chatId)) ?? {};
  await setJSON(`access:${chatId}`, { ...existing, status }, ttl);
}

export async function deleteAccess(chatId) {
  await del(`access:${chatId}`);
}

/** Toate chat-urile cu acces aprobat -- pentru /utilizatori. SCAN (non-blocant), nu KEYS. */
export async function listApprovedAccess() {
  const client = await getClient();
  const result = [];
  // scanIterator produce un ARRAY de chei per pagina (nu o cheie per iteratie) -- vezi
  // node_modules/@redis/client/dist/lib/client/index.d.ts.
  for await (const keys of client.scanIterator({ MATCH: 'access:*', COUNT: 100 })) {
    for (const key of keys) {
      const record = await getJSON(key);
      if (record?.status === 'approved') {
        result.push({ chatId: key.slice('access:'.length), name: record.name, username: record.username });
      }
    }
  }
  return result;
}

/** Toate cererile de acces, orice status -- pentru /cereri. SCAN (non-blocant), nu KEYS. */
export async function listAllAccess() {
  const client = await getClient();
  const result = [];
  for await (const keys of client.scanIterator({ MATCH: 'access:*', COUNT: 100 })) {
    for (const key of keys) {
      const record = await getJSON(key);
      if (record) {
        result.push({ chatId: key.slice('access:'.length), ...record });
      }
    }
  }
  return result;
}

// --- Rate limiting per chat + global (fara date personale, fara criptare) -----------

/** true daca acest chat NU a verificat in ultima fereastra (si marcheaza acum ca a facut-o). */
export async function tryAcquireRateLimit(chatId, windowSeconds = RATE_LIMIT_CHAT_WINDOW_SECONDS) {
  const client = await getClient();
  const set = await client.set(`rl:chat:${chatId}`, '1', { EX: windowSeconds, NX: true });
  return set === 'OK';
}

// --- Limita zilnica ASP (HTTP 429) per IDNP -------------------------------------------
//
// ASP limiteaza cererile `dates` per IDNP, zilnic (verificat live 24.09.2026). Cheia e
// hash-ul IDNP-ului, NU IDNP-ul in clar -- cheile Redis nu sunt criptate, iar IDNP-ul e
// date personale. Valoarea (un timestamp ISO public) nu e sensibila. TTL = pana la
// `until`, deci limita expira singura din Redis, fara curatare.

function aspBlockKey(idnp) {
  return `asp:blocked:${createHash('sha256').update(String(idnp)).digest('hex')}`;
}

/** Date-ul pana cand ASP a limitat acest IDNP, sau null daca nu e (sau a expirat) limitat. */
export async function getAspBlock(idnp) {
  const client = await getClient();
  const raw = await client.get(aspBlockKey(idnp));
  if (!raw) return null;
  const until = new Date(raw);
  return Number.isNaN(until.getTime()) || until <= new Date() ? null : until;
}

export async function setAspBlock(idnp, until) {
  const ttl = Math.ceil((until.getTime() - Date.now()) / 1000);
  if (ttl <= 0) return;
  const client = await getClient();
  await client.set(aspBlockKey(idnp), until.toISOString(), { EX: ttl });
}

// --- Notificari automate pentru invitati (src/guests.js) -------------------------------
//
// `checker:guest:<chatId>` = state-ul de diff al invitatului (zile libere publice + flaguri,
// acelasi format ca state/slots.json al proprietarului) -- fara date personale, deci
// necriptat. TTL reinnoit la fiecare rulare: un invitat inactiv (sters/revocat fara ca
// cheia sa fi fost curatata) dispare singur.
// `notify:<chatId>` = 'off' cand invitatul si-a oprit notificarile; lipsa = pornite.

const GUEST_STATE_TTL_SECONDS = 60 * 60 * 24 * 90;

export async function getGuestState(chatId) {
  const client = await getClient();
  const raw = await client.get(`checker:guest:${chatId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setGuestState(chatId, state) {
  const client = await getClient();
  await client.set(`checker:guest:${chatId}`, JSON.stringify(state), { EX: GUEST_STATE_TTL_SECONDS });
}

export async function isNotifyEnabled(chatId) {
  const client = await getClient();
  return (await client.get(`notify:${chatId}`)) !== 'off';
}

export async function setNotifyEnabled(chatId, enabled) {
  const client = await getClient();
  if (enabled) await client.del(`notify:${chatId}`);
  else await client.set(`notify:${chatId}`, 'off');
}

/** Sterge tot ce tine de notificarile si setarile unui chat (la /sterge si /revoca). */
export async function deleteGuestNotifyData(chatId) {
  const client = await getClient();
  await client.del([`checker:guest:${chatId}`, `notify:${chatId}`, `prefs:${chatId}`]);
}

// --- Setari (/setari) -------------------------------------------------------------------
// `prefs:<chatId>` = { teoretic, practic, obisnuit, urgent, locations, before } -- doar
// boolean-uri + o data, fara date personale: necriptat si fara TTL (o inregistrare ramasa
// pentru un chat abandonat e inofensiva; /sterge si /revoca o curata oricum). Normalizarea
// (valori lipsa/corupte -> implicite) se face in src/prefs.js, nu aici.

export async function getPrefs(chatId) {
  const client = await getClient();
  const raw = await client.get(`prefs:${chatId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setPrefs(chatId, prefs) {
  const client = await getClient();
  await client.set(`prefs:${chatId}`, JSON.stringify(prefs));
}

// --- Status pentru /status (admin) ------------------------------------------------------
// `status:owner` = starea checker-ului proprietarului (trimisa de CI la api/notify-guests.js),
// `status:guests` = rezultatul ultimei rulari a buclei de invitati. Fara date personale.

export async function getStatus(name) {
  const client = await getClient();
  const raw = await client.get(`status:${name}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setStatus(name, value) {
  const client = await getClient();
  await client.set(`status:${name}`, JSON.stringify(value));
}

/**
 * Lock cu TTL impotriva a doua rulari simultane ale buclei de invitati (ex. CI + un apel
 * manual) -- altfel ar trimite fiecare alerta de doua ori. Expira singur daca o invocare
 * se agata. true = lock obtinut; apelantul trebuie sa-l elibereze cu releaseGuestRunLock.
 */
export async function tryAcquireGuestRunLock(ttlSeconds = 150) {
  const client = await getClient();
  return (await client.set('checker:guests:lock', '1', { EX: ttlSeconds, NX: true })) === 'OK';
}

export async function releaseGuestRunLock() {
  const client = await getClient();
  await client.del('checker:guests:lock');
}

/** Incrementeaza contorul global pe fereastra curenta; true daca s-a depasit pragul. */
export async function isGlobalRateLimited(max = RATE_LIMIT_GLOBAL_MAX) {
  const client = await getClient();
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_GLOBAL_WINDOW_SECONDS * 1000));
  const key = `rl:global:${bucket}`;
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, RATE_LIMIT_GLOBAL_WINDOW_SECONDS);
  return count > max;
}
