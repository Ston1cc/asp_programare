// Webhook Telegram, gazduit pe Vercel -- raspuns aproape instant la "/acum" (spre
// deosebire de varianta cu polling pe GitHub Actions, care avea un plafon de ~5 minute).
// Telegram trimite update-ul direct aici de indata ce userul scrie botului, deci nu mai
// e nevoie de offset/state -- fiecare update e livrat o singura data, procesat pe loc.
//
// Trei categorii de chat-uri:
//   - proprietarul (cfg.telegram.chatId, din .env) -- foloseste mereu datele personale
//     din .env, comportament neschimbat de la inceput.
//   - un chat aprobat de proprietar -- si-a introdus datele (IDNP/serie/data eliberarii)
//     prin fluxul din src/registration.js; stocate criptat per chat_id in
//     src/userStore.js, NU in .env si NU alaturi de datele proprietarului.
//   - orice alt chat -- necunoscut botului pana proprietarul ii aproba manual cererea de
//     acces (buton inline Aproba/Respinge) -- vezi CLAUDE.md pentru motivul acestui pas:
//     fara el, oricine putea sa-si inregistreze IDNP-ul, facand din proprietar operator
//     de date personale pentru straini, fara control.

import { loadConfig } from '../src/config.js';
import { isValidSecret } from '../src/secret.js';
import { TRIGGER_COMMANDS, buildLiveReply } from '../src/live.js';
import {
  sendTelegramMessage,
  answerCallbackQuery,
  editMessageText,
  deleteMessage,
  leaveChat,
  ACUM_KEYBOARD,
  REGISTERED_KEYBOARD,
  REGISTER_KEYBOARD,
  BOOKING_KEYBOARD,
} from '../src/telegram.js';
import { escapeMarkdownV2 } from '../src/format.js';
import {
  REGISTER_COMMANDS,
  DELETE_COMMAND,
  HELP_COMMAND,
  LIST_USERS_COMMAND,
  REVOKE_COMMAND,
  startRegistrationPrompt,
  advanceRegistration,
  buildHelpMessage,
  ACCESS_PENDING_MESSAGE,
  ACCESS_DENIED_MESSAGE,
  ACCESS_REQUESTED_MESSAGE,
  formatAccessRequestText,
  buildAccessDecisionLine,
  buildAccessDecisionMessage,
} from '../src/registration.js';
import {
  getPerson,
  setPerson,
  deletePerson,
  getPendingRegistration,
  setPendingRegistration,
  clearPendingRegistration,
  getAccess,
  requestAccessIfNew,
  setAccessStatus,
  deleteAccess,
  listApprovedAccess,
  tryAcquireRateLimit,
  isGlobalRateLimited,
  touchUser,
} from '../src/userStore.js';

export const config = { maxDuration: 30 };

const UNAVAILABLE_MESSAGE = `⚠️ ${escapeMarkdownV2('Serviciu temporar indisponibil — încearcă din nou peste câteva minute.')}`;

// Cooldown intre doua verificari live PENTRU PROPRIETAR -- in memorie, per instanta
// serverless. Corect doar pentru proprietar (un singur chat fix): pentru orice alt chat
// folosim rate-limit-ul din Redis (userStore.js), per chat, ca userii sa nu se blocheze
// unii pe altii (cooldown-ul vechi era global si nedrept intre useri diferiti -- vezi
// CLAUDE.md). Best-effort: traieste doar cat instanta ramane calda intre invocari.
const OWNER_COOLDOWN_MS = 45_000;
let ownerLastCheckAt = 0;

async function replyTo(botToken, chatId, text, keyboard) {
  await sendTelegramMessage({ botToken, chatId }, text, keyboard);
}

async function runOwnerLiveCheck(botToken, chatId, person, keyboard) {
  const now = Date.now();
  const elapsed = now - ownerLastCheckAt;
  if (elapsed < OWNER_COOLDOWN_MS) {
    const waitSec = Math.ceil((OWNER_COOLDOWN_MS - elapsed) / 1000);
    await replyTo(botToken, chatId, escapeMarkdownV2(`⏳ Ai verificat recent — mai așteaptă ${waitSec}s.`), keyboard);
    return;
  }
  ownerLastCheckAt = now;
  const { message: reply } = await buildLiveReply(person);
  // BOOKING_KEYBOARD (inline), nu `keyboard` -- tastatura persistenta de sub campul de
  // text nu dispare doar pentru ca acest mesaj foloseste un alt reply_markup, vezi
  // comentariul de la BOOKING_KEYBOARD in telegram.js.
  await replyTo(botToken, chatId, reply, BOOKING_KEYBOARD);
}

async function runUserLiveCheck(botToken, chatId, person, keyboard) {
  try {
    const acquired = await tryAcquireRateLimit(chatId);
    if (!acquired) {
      await replyTo(botToken, chatId, escapeMarkdownV2('⏳ Ai verificat recent — mai așteaptă puțin.'), keyboard);
      return;
    }
    if (await isGlobalRateLimited()) {
      await replyTo(botToken, chatId, escapeMarkdownV2('🚦 Botul e aglomerat chiar acum — mai încearcă peste un minut.'), keyboard);
      return;
    }
  } catch (err) {
    console.error('Eroare la rate-limit (Redis):', err.message);
    await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, keyboard);
    return;
  }
  const { message: reply } = await buildLiveReply(person);
  await replyTo(botToken, chatId, reply, BOOKING_KEYBOARD);

  // Reinnoieste TTL-ul (vezi userStore.js) -- best-effort, dupa ce raspunsul a plecat deja:
  // un chat activ nu trebuie scos din sistem doar pentru ca 90 de zile au trecut de la
  // inregistrare/aprobare, cat timp inca foloseste botul.
  try {
    await touchUser(chatId);
  } catch (err) {
    console.error('Eroare la reinnoirea TTL-ului:', err.message);
  }
}

async function handleOwnerMessage(cfg, rawText, text) {
  const { botToken, chatId } = cfg.telegram;

  if (text === HELP_COMMAND) {
    await replyTo(botToken, chatId, buildHelpMessage({ isOwner: true }), ACUM_KEYBOARD);
    return;
  }

  if (text === LIST_USERS_COMMAND) {
    let list = [];
    try {
      list = await listApprovedAccess();
    } catch (err) {
      await replyTo(botToken, chatId, escapeMarkdownV2(`Eroare la citirea listei: ${err.message}`), ACUM_KEYBOARD);
      return;
    }
    const body =
      list.length === 0
        ? escapeMarkdownV2('Niciun utilizator aprobat momentan.')
        : list
            .map((u) =>
              escapeMarkdownV2(`• ${u.name || '(fără nume)'}${u.username ? ' @' + u.username : ''} — chat_id ${u.chatId}`),
            )
            .join('\n');
    await replyTo(botToken, chatId, `👥 *${escapeMarkdownV2('Utilizatori aprobați')}*\n\n${body}`, ACUM_KEYBOARD);
    return;
  }

  if (text.startsWith(`${REVOKE_COMMAND} `)) {
    const targetChatId = rawText.slice(REVOKE_COMMAND.length).trim();
    await deleteAccess(targetChatId);
    await deletePerson(targetChatId);
    await clearPendingRegistration(targetChatId);
    await replyTo(botToken, chatId, escapeMarkdownV2(`Acces revocat pentru chat_id ${targetChatId}.`), ACUM_KEYBOARD);
    return;
  }

  if (TRIGGER_COMMANDS.has(text)) {
    await runOwnerLiveCheck(botToken, chatId, cfg.person, ACUM_KEYBOARD);
  }
}

async function handleGuestMessage(cfg, message, rawText, text) {
  const { botToken, chatId: ownerId } = cfg.telegram;
  const chatId = message.chat.id;

  // Botul nu trebuie folosit in grupuri -- oricine din grup ar vedea IDNP-ul scris de
  // altcineva si ar putea rula /acum sau /sterge pe datele lui. Iese imediat, inaintea
  // oricarei alte procesari.
  if (message.chat.type !== 'private') {
    try {
      await leaveChat(botToken, chatId);
    } catch (err) {
      console.error('Eroare la leaveChat:', err.message);
    }
    return;
  }

  // /help si /sterge raman disponibile oricui, indiferent de starea de acces -- iesirea
  // din confuzie, respectiv dreptul de a-si sterge datele, nu trebuie sa astepte aprobare.
  if (text === HELP_COMMAND) {
    let hasPerson = false;
    let needsApproval = true;
    try {
      const [person, accessForHelp] = await Promise.all([getPerson(chatId), getAccess(chatId)]);
      hasPerson = Boolean(person);
      needsApproval = accessForHelp?.status !== 'approved';
    } catch (err) {
      // Best-effort -- /help trebuie sa raspunda si daca Redis e jos, presupunem
      // varianta cea mai restrictiva (mai sigura: nu promite butoane care n-ar functiona).
      console.error('Eroare la citirea starii pentru /help:', err.message);
    }
    const keyboard = hasPerson ? REGISTERED_KEYBOARD : REGISTER_KEYBOARD;
    await replyTo(botToken, chatId, buildHelpMessage({ isOwner: false, hasPerson, needsApproval }), keyboard);
    return;
  }

  if (text === DELETE_COMMAND) {
    await deletePerson(chatId);
    await clearPendingRegistration(chatId);
    await replyTo(botToken, chatId, escapeMarkdownV2('🗑️ Datele tale au fost șterse.'), REGISTER_KEYBOARD);
    return;
  }

  let access;
  try {
    access = await getAccess(chatId);
  } catch (err) {
    console.error('Eroare la citirea accesului:', err.message);
    await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, REGISTER_KEYBOARD);
    return;
  }

  if (access?.status !== 'approved') {
    if (access?.status === 'denied') {
      await replyTo(botToken, chatId, ACCESS_DENIED_MESSAGE, REGISTER_KEYBOARD);
      return;
    }
    if (access?.status === 'pending') {
      await replyTo(botToken, chatId, ACCESS_PENDING_MESSAGE, REGISTER_KEYBOARD);
      return;
    }

    // Nicio cerere inca -- o cream o singura data (SET NX in userStore), ca un strain sa
    // nu poata bombarda proprietarul cu notificari repetate doar retrimitand mesajul.
    const meta = {
      chatId: String(chatId),
      name: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null,
      username: message.from?.username || null,
    };
    let created = false;
    try {
      created = await requestAccessIfNew(chatId, meta);
    } catch (err) {
      console.error('Eroare la crearea cererii de acces:', err.message);
      await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, REGISTER_KEYBOARD);
      return;
    }
    if (created) {
      const approveKeyboard = {
        inline_keyboard: [
          [
            { text: '✅ Aprobă', callback_data: `approve:${chatId}` },
            { text: '❌ Respinge', callback_data: `deny:${chatId}` },
          ],
        ],
      };
      try {
        await sendTelegramMessage({ botToken, chatId: ownerId }, formatAccessRequestText(meta), approveKeyboard);
      } catch (err) {
        console.error('Eroare la notificarea proprietarului:', err.message);
      }
    }
    await replyTo(botToken, chatId, ACCESS_REQUESTED_MESSAGE, REGISTER_KEYBOARD);
    return;
  }

  // De aici incolo: acces aprobat -- comportamentul de dinainte de audit-ul de securitate.
  const pending = await getPendingRegistration(chatId);
  if (pending) {
    const result = advanceRegistration(pending, rawText);
    if (result.cancelled) {
      await clearPendingRegistration(chatId);
      await replyTo(botToken, chatId, result.reply, REGISTER_KEYBOARD);
      return;
    }
    // rawText a fost o incercare (valida sau nu) de IDNP/serie/data -- stergem mesajul
    // userului indiferent de rezultat, ca datele scrise sa nu ramana la vedere in
    // istoricul chat-ului.
    try {
      await deleteMessage(botToken, chatId, message.message_id);
    } catch (err) {
      console.error('Eroare la stergerea mesajului cu date:', err.message);
    }
    if (result.person) {
      await setPerson(chatId, result.person);
      await clearPendingRegistration(chatId);
      await replyTo(botToken, chatId, result.reply, REGISTERED_KEYBOARD);
    } else {
      await setPendingRegistration(chatId, result.pending);
      await replyTo(botToken, chatId, result.reply, REGISTER_KEYBOARD);
    }
    return;
  }

  if (REGISTER_COMMANDS.has(text)) {
    const { pending: newPending, reply } = startRegistrationPrompt();
    await setPendingRegistration(chatId, newPending);
    await replyTo(botToken, chatId, reply, REGISTER_KEYBOARD);
    return;
  }

  if (TRIGGER_COMMANDS.has(text)) {
    const person = await getPerson(chatId);
    if (person) {
      await runUserLiveCheck(botToken, chatId, person, REGISTERED_KEYBOARD);
    } else {
      const { pending: newPending, reply } = startRegistrationPrompt();
      await setPendingRegistration(chatId, newPending);
      await replyTo(botToken, chatId, reply, REGISTER_KEYBOARD);
    }
  }
}

async function handleCallbackQuery(cfg, cq) {
  const { botToken, chatId: ownerId } = cfg.telegram;

  if (String(cq.from?.id) !== String(ownerId)) {
    // Cineva a apasat un buton dar nu e proprietarul -- nu avem incredere orbeste in
    // continutul payload-ului, doar in identitatea confirmata de Telegram (`from.id`).
    await answerCallbackQuery(botToken, cq.id, 'Doar proprietarul poate decide.');
    return;
  }

  const [action, targetChatId] = String(cq.data || '').split(':');
  if (action !== 'approve' && action !== 'deny') {
    await answerCallbackQuery(botToken, cq.id, '');
    return;
  }

  const status = action === 'approve' ? 'approved' : 'denied';
  const existing = await getAccess(targetChatId);
  await setAccessStatus(targetChatId, status);
  await answerCallbackQuery(botToken, cq.id, status === 'approved' ? 'Aprobat.' : 'Respins.');

  if (cq.message?.chat?.id != null && cq.message?.message_id != null) {
    const updatedText = `${formatAccessRequestText({
      chatId: targetChatId,
      name: existing?.name,
      username: existing?.username,
    })}\n\n${buildAccessDecisionLine(status)}`;
    try {
      await editMessageText(botToken, cq.message.chat.id, cq.message.message_id, updatedText);
    } catch (err) {
      console.error('Eroare la editarea mesajului de cerere:', err.message);
    }
  }

  try {
    await replyTo(botToken, targetChatId, buildAccessDecisionMessage(status), REGISTER_KEYBOARD);
  } catch (err) {
    console.error('Eroare la notificarea solicitantului:', err.message);
  }
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
  if (!isValidSecret(secret, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const cfg = loadConfig();

    const callbackQuery = req.body?.callback_query;
    if (callbackQuery) {
      await handleCallbackQuery(cfg, callbackQuery);
    } else {
      const message = req.body?.message;
      if (message?.chat?.id != null && typeof message.text === 'string') {
        const chatId = message.chat.id;
        const rawText = message.text.trim();
        const text = rawText.toLowerCase();

        if (String(chatId) === String(cfg.telegram.chatId)) {
          await handleOwnerMessage(cfg, rawText, text);
        } else {
          await handleGuestMessage(cfg, message, rawText, text);
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
