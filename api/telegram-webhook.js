// Webhook Telegram, gazduit pe Vercel -- raspuns aproape instant la "/acum" (spre
// deosebire de varianta cu polling pe GitHub Actions, care avea un plafon de ~5 minute).
// Telegram trimite update-ul direct aici de indata ce userul scrie botului, deci nu mai
// e nevoie de offset/state -- fiecare update e livrat o singura data, procesat pe loc.
//
// Doua categorii de chat-uri:
//   - proprietarul (cfg.telegram.chatId, din .env) -- foloseste mereu datele personale
//     din .env, comportament neschimbat de la inceput.
//   - orice alt chat -- necunoscut botului pana isi introduce singur datele (IDNP/serie/
//     data eliberarii) prin fluxul din src/registration.js; stocate per chat_id in
//     src/userStore.js (Upstash), NU in .env si NU alaturi de datele proprietarului.

import { loadConfig } from '../src/config.js';
import { TRIGGER_COMMANDS, buildLiveReply } from '../src/live.js';
import { sendTelegramMessage, ACUM_KEYBOARD, REGISTERED_KEYBOARD, REGISTER_KEYBOARD } from '../src/telegram.js';
import { escapeMarkdownV2 } from '../src/format.js';
import {
  REGISTER_COMMANDS,
  DELETE_COMMAND,
  HELP_COMMAND,
  startRegistrationPrompt,
  advanceRegistration,
  buildHelpMessage,
} from '../src/registration.js';
import { getPerson, setPerson, deletePerson, getPendingRegistration, setPendingRegistration, clearPendingRegistration } from '../src/userStore.js';

export const config = { maxDuration: 30 };

// Cooldown intre doua verificari live, ca sa nu bombardam ASP daca cineva apasa "/acum"
// repetat (dublu-tap, retry de client etc). Global, nu per-chat -- protejeaza ASP de
// volumul total, indiferent cati oameni foloseasc botul. Best-effort: traieste doar cat
// instanta serverless ramane "calda" intre invocari.
const COOLDOWN_MS = 45_000;
let lastCheckAt = 0;

async function replyTo(botToken, chatId, text, keyboard) {
  await sendTelegramMessage({ botToken, chatId }, text, keyboard);
}

async function runLiveCheck(botToken, chatId, person, keyboard) {
  const now = Date.now();
  const elapsed = now - lastCheckAt;
  if (elapsed < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
    await replyTo(botToken, chatId, escapeMarkdownV2(`⏳ Ai verificat recent — mai așteaptă ${waitSec}s.`), keyboard);
    return;
  }
  lastCheckAt = now;
  const { message: reply } = await buildLiveReply(person);
  await replyTo(botToken, chatId, reply, keyboard);
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

    if (message?.chat?.id != null && typeof message.text === 'string') {
      const chatId = message.chat.id;
      const rawText = message.text.trim();
      const text = rawText.toLowerCase();
      const { botToken } = cfg.telegram;

      if (String(chatId) === String(cfg.telegram.chatId)) {
        // Proprietarul -- comportament original, neschimbat.
        if (text === HELP_COMMAND) {
          await replyTo(botToken, chatId, buildHelpMessage({ isOwner: true }), ACUM_KEYBOARD);
        } else if (TRIGGER_COMMANDS.has(text)) {
          await runLiveCheck(botToken, chatId, cfg.person, ACUM_KEYBOARD);
        }
      } else {
        // Oricine altcineva. /help e verificat PRIMUL, inaintea starii de `pending` --
        // e comanda de iesire din confuzie, trebuie sa mearga chiar daca cineva e blocat
        // la jumatatea inregistrarii, nu ingropata dupa validarea unui pas.
        if (text === HELP_COMMAND) {
          let hasPerson = false;
          try {
            hasPerson = Boolean(await getPerson(chatId));
          } catch (err) {
            // Best-effort -- /help trebuie sa raspunda si daca Redis e jos, presupunem
            // varianta neinregistrat (mai sigura: nu promite butoane care n-ar functiona).
            console.error('Eroare la citirea persoanei pentru /help:', err.message);
          }
          const keyboard = hasPerson ? REGISTERED_KEYBOARD : REGISTER_KEYBOARD;
          await replyTo(botToken, chatId, buildHelpMessage({ isOwner: false, hasPerson }), keyboard);
          res.status(200).json({ ok: true });
          return;
        }

        if (text === DELETE_COMMAND) {
          await deletePerson(chatId);
          await clearPendingRegistration(chatId);
          await replyTo(
            botToken,
            chatId,
            escapeMarkdownV2('🗑️ Datele tale au fost șterse.'),
            REGISTER_KEYBOARD,
          );
          res.status(200).json({ ok: true });
          return;
        }

        const pending = await getPendingRegistration(chatId);
        if (pending) {
          const result = advanceRegistration(pending, rawText);
          if (result.person) {
            await setPerson(chatId, result.person);
            await clearPendingRegistration(chatId);
            await replyTo(botToken, chatId, result.reply, REGISTERED_KEYBOARD);
          } else {
            await setPendingRegistration(chatId, result.pending);
            await replyTo(botToken, chatId, result.reply, REGISTER_KEYBOARD);
          }
          res.status(200).json({ ok: true });
          return;
        }

        if (REGISTER_COMMANDS.has(text)) {
          const { pending: newPending, reply } = startRegistrationPrompt();
          await setPendingRegistration(chatId, newPending);
          await replyTo(botToken, chatId, reply, REGISTER_KEYBOARD);
          res.status(200).json({ ok: true });
          return;
        }

        if (TRIGGER_COMMANDS.has(text)) {
          const person = await getPerson(chatId);
          if (person) {
            await runLiveCheck(botToken, chatId, person, REGISTERED_KEYBOARD);
          } else {
            const { pending: newPending, reply } = startRegistrationPrompt();
            await setPendingRegistration(chatId, newPending);
            await replyTo(botToken, chatId, reply, REGISTER_KEYBOARD);
          }
        }
      }
    }
  } catch (err) {
    // Nu lasam eroarea sa propage catre Telegram ca 5xx -- ar declansa retry-uri repetate
    // ale ACELUIASI update. O logam si raspundem 200 oricum.
    console.error('Eroare in webhook:', err);
  }

  res.status(200).json({ ok: true });
}
