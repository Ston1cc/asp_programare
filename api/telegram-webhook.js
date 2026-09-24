// Webhook Telegram, gazduit pe Vercel -- raspuns aproape instant la "/acum" (spre
// deosebire de varianta cu polling pe GitHub Actions, care avea un plafon de ~5 minute).
// Telegram trimite update-ul direct aici de indata ce userul scrie botului, deci nu mai
// e nevoie de offset/state -- fiecare update e livrat o singura data, procesat pe loc.
//
// Pe langa comenzile live ("/acum" etc.), gestioneaza si "/inregistrare" -- fluxul prin care
// ORICE persoana (nu doar owner-ul din .env) isi poate inregistra propriile date (IDNP, serie
// buletin, data eliberare) ca sa primeasca verificari/alerte pe propriul chat. Inregistrarile
// se salveaza in state/users.json prin GitHub Contents API (src/github-storage.js) -- webhook-ul
// nu are un checkout de git persistent din care sa faca commit ca src/index.js.

import { loadConfig } from '../src/config.js';
import { TRIGGER_COMMANDS, buildLiveReply } from '../src/live.js';
import { sendTelegramMessage } from '../src/telegram.js';
import { escapeMarkdownV2 } from '../src/format.js';
import { isValidIdnp, isValidSeria, isValidIssueDateInput, toIssueDateIso } from '../src/users.js';
import { readUsers, updateUsers } from '../src/github-storage.js';

export const config = { maxDuration: 30 };

// Cooldown intre doua verificari live, per chat -- ca sa nu bombardam ASP daca cineva apasa
// "/acum" repetat (dublu-tap, retry de client etc), fara ca activitatea unui user sa blocheze
// verificarea altuia. Best-effort: traieste doar cat instanta serverless ramane "calda" intre
// invocari -- Vercel de obicei o pastreaza minute bune, deci acopera cazul real
// (impacientare), fara sa garanteze protectie absoluta la un atac deliberat.
const COOLDOWN_MS = 45_000;
const lastCheckAt = new Map(); // chatId -> timestamp ms

// Conversatia de inregistrare (IDNP -> serie -> data), tinuta in memorie -- acelasi
// best-effort ca lastCheckAt: daca instanta se raceste intre doua mesaje ale userului (rar,
// schimbul dureaza cateva secunde), userul pur si simplu reia cu "/inregistrare". Nu merita
// complexitatea unei persistente reale pentru 2-3 mesaje schimbate o singura data.
const pendingRegistrations = new Map(); // chatId -> { step: 'idnp'|'seria'|'data', idnp?, seriaAndNumber? }

function githubConfig() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  return { token, repo, branch: process.env.GITHUB_BRANCH || 'master' };
}

function reply(cfg, chatId, text) {
  return sendTelegramMessage(cfg.telegram, text, chatId);
}

async function handleRegistrationStep(cfg, gh, chatId, text) {
  const pending = pendingRegistrations.get(chatId);

  if (pending.step === 'idnp') {
    if (!isValidIdnp(text)) {
      await reply(cfg, chatId, escapeMarkdownV2('IDNP invalid — trebuie să fie exact 13 cifre. Mai încearcă:'));
      return;
    }
    pending.idnp = text;
    pending.step = 'seria';
    await reply(cfg, chatId, escapeMarkdownV2('Acum trimite seria buletinului (2 litere + 7 cifre, ex. EA0039316).'));
    return;
  }

  if (pending.step === 'seria') {
    if (!isValidSeria(text)) {
      await reply(cfg, chatId, escapeMarkdownV2('Serie invalidă — 2 litere + 7 cifre (ex. EA0039316). Mai încearcă:'));
      return;
    }
    pending.seriaAndNumber = text.toUpperCase();
    pending.step = 'data';
    await reply(
      cfg,
      chatId,
      escapeMarkdownV2('Acum trimite data eliberării buletinului, format AAAA-LL-ZZ (ex. 2025-05-16).'),
    );
    return;
  }

  // pending.step === 'data'
  if (!isValidIssueDateInput(text)) {
    await reply(cfg, chatId, escapeMarkdownV2('Dată invalidă — format AAAA-LL-ZZ (ex. 2025-05-16). Mai încearcă:'));
    return;
  }
  const record = {
    idnp: pending.idnp,
    seriaAndNumber: pending.seriaAndNumber,
    issueDate: toIssueDateIso(text),
    registeredAt: new Date().toISOString(),
  };
  await updateUsers(gh, (users) => ({ ...users, [chatId]: record }), `state: inregistrare user ${chatId} [skip ci]`);
  pendingRegistrations.delete(chatId);
  await reply(
    cfg,
    chatId,
    escapeMarkdownV2(
      '✅ Te-ai înregistrat! Scrie /acum oricând ca să vezi live cele mai apropiate date pentru tine. Ca să te ștergi din monitorizare, scrie /dezinregistrare.',
    ),
  );
}

async function handleMessage(cfg, message) {
  const chatId = String(message.chat.id);
  const text = (message.text ?? '').trim();
  const lower = text.toLowerCase();
  const isOwner = chatId === String(cfg.telegram.chatId);
  const gh = githubConfig();

  if (lower === '/inregistrare') {
    pendingRegistrations.set(chatId, { step: 'idnp' });
    await reply(cfg, chatId, escapeMarkdownV2('Trimite IDNP-ul tău (13 cifre).'));
    return;
  }

  if (lower === '/anuleaza' && pendingRegistrations.has(chatId)) {
    pendingRegistrations.delete(chatId);
    await reply(cfg, chatId, escapeMarkdownV2('Înregistrare anulată.'));
    return;
  }

  if (lower === '/dezinregistrare') {
    pendingRegistrations.delete(chatId);
    if (!gh) {
      await reply(cfg, chatId, escapeMarkdownV2('Dezînregistrarea nu e configurată pe acest deploy.'));
      return;
    }
    const { users } = await readUsers(gh);
    const existed = Boolean(users[chatId]);
    if (existed) {
      await updateUsers(
        gh,
        (current) => {
          const next = { ...current };
          delete next[chatId];
          return next;
        },
        `state: dezinregistrare user ${chatId} [skip ci]`,
      );
    }
    await reply(cfg, chatId, escapeMarkdownV2(existed ? 'Te-am șters din monitorizare.' : 'Nu erai înregistrat.'));
    return;
  }

  if (pendingRegistrations.has(chatId)) {
    if (text.startsWith('/') && lower !== '/inregistrare') {
      pendingRegistrations.delete(chatId);
      await reply(cfg, chatId, escapeMarkdownV2('Înregistrare anulată (ai trimis o comandă).'));
      // continua mai jos -- comanda trimisa (ex. "/acum") tot trebuie procesata normal.
    } else {
      if (!gh) {
        pendingRegistrations.delete(chatId);
        await reply(
          cfg,
          chatId,
          escapeMarkdownV2('Înregistrarea nu e configurată pe acest deploy (lipsește GITHUB_TOKEN/GITHUB_REPO).'),
        );
        return;
      }
      await handleRegistrationStep(cfg, gh, chatId, text);
      return;
    }
  }

  if (!TRIGGER_COMMANDS.has(lower)) return;

  let person;
  if (isOwner) {
    person = cfg.person;
  } else if (gh) {
    const { users } = await readUsers(gh);
    const user = users[chatId];
    if (!user) {
      await reply(cfg, chatId, escapeMarkdownV2('Nu ești înregistrat. Scrie /inregistrare ca să te înregistrezi.'));
      return;
    }
    person = { idnp: user.idnp, seriaAndNumber: user.seriaAndNumber, issueDate: user.issueDate };
  } else {
    await reply(
      cfg,
      chatId,
      escapeMarkdownV2('Nu ești proprietarul botului, iar înregistrarea nu e configurată pe acest deploy.'),
    );
    return;
  }

  const now = Date.now();
  const last = lastCheckAt.get(chatId) ?? 0;
  const elapsed = now - last;
  if (elapsed < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    await reply(cfg, chatId, escapeMarkdownV2(`⏳ Ai verificat recent — mai așteaptă ${waitSec}s.`));
    return;
  }
  lastCheckAt.set(chatId, now);
  const { message: liveReply } = await buildLiveReply(person);
  await reply(cfg, chatId, liveReply);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  // Telegram trimite acest header pe fiecare cerere de webhook cand secret_token e setat
  // la setWebhook -- singura protectie ca nu oricine poate declansa un fetch live doar
  // stiind URL-ul (public prin natura unui webhook).
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const cfg = loadConfig();
    const message = req.body?.message;

    // Doar chat-uri private -- inregistrarea colecteaza date personale (IDNP, serie
    // buletin), n-are ce cauta intr-un grup unde le-ar vedea oricine.
    if (message && message.chat?.type === 'private') {
      await handleMessage(cfg, message);
    }
  } catch (err) {
    // Nu lasam eroarea sa propage catre Telegram ca 5xx -- ar declansa retry-uri repetate
    // ale ACELUIASI update. O logam si raspundem 200 oricum.
    console.error('Eroare in webhook:', err);
  }

  res.status(200).json({ ok: true });
}
