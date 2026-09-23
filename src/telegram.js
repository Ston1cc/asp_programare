// Client minimal Telegram Bot API -- fetch nativ, zero dependente.

import { splitMessage } from './format.js';
import { BOOKING_URL } from './config.js';

// Tastaturi persistente (reply keyboard, NU inline) atasate la mesajele trimise de bot --
// userul apasa un buton in loc sa scrie manual comanda. Textul butonului trebuie sa fie
// EXACT o comanda recunoscuta (TRIGGER_COMMANDS in src/live.js sau REGISTER_COMMAND in
// api/telegram-webhook.js) -- Telegram trimite inapoi ca mesaj text chiar eticheta
// butonului, nu un cod separat (asta e diferenta fata de un inline keyboard cu
// callback_data), deci webhook-ul o proceseaza prin acelasi flux ca orice comanda scrisa
// de mana, fara cod nou. `is_persistent` -- ramane vizibila dupa ce e apasata o data.
//
// Trei variante, alese de webhook dupa starea chat-ului -- fiecare arata DOAR comenzile
// aplicabile starii respective (proprietarul n-are ce face cu /inregistrare sau /sterge,
// datele lui vin din .env), plus /help peste tot ca iesire din confuzie:
//   ACUM_KEYBOARD       -- proprietarul botului (are mereu date, din .env)
//   REGISTERED_KEYBOARD -- alta persoana care si-a salvat deja datele
//   REGISTER_KEYBOARD   -- alta persoana necunoscuta botului
export const ACUM_KEYBOARD = {
  keyboard: [[{ text: '/acum' }, { text: '/help' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const REGISTERED_KEYBOARD = {
  keyboard: [[{ text: '/acum' }, { text: '/sterge' }], [{ text: '/help' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const REGISTER_KEYBOARD = {
  keyboard: [[{ text: '/inregistrare' }, { text: '/help' }]],
  resize_keyboard: true,
  is_persistent: true,
};

// Tastatura de o singura data pentru pasul "vehicle" din inregistrare (src/registration.js)
// -- disparea dupa apasare (one_time_keyboard), Telegram revine la ultima tastatura
// persistenta (REGISTER_KEYBOARD, inca vizibila mai jos in acelasi flux) dupa ce userul
// raspunde. Userul poate oricum scrie manual "manuală"/"automată" in loc sa apese.
export const VEHICLE_KEYBOARD = {
  keyboard: [[{ text: '🔧 Manuală' }, { text: '⚙️ Automată' }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// Inline keyboard cu un buton "Programează-te", atasat mesajelor care anunta o zi noua/mai
// devreme (alerta 🔥, zile noi, si raspunsul /acum) -- mai putine atingeri intre alerta si
// deschiderea site-ului de programare. Deliberat un inline keyboard (nu reply keyboard),
// ca sa nu inlocuiasca tastatura persistenta (ACUM/REGISTERED_KEYBOARD) de sub campul de
// text; Telegram poate arata amandoua simultan (una sub mesaj, cealalta sub camp).
export const BOOKING_KEYBOARD = {
  inline_keyboard: [[{ text: '📝 Programează-te', url: BOOKING_URL }]],
};

/** Apel generic la Telegram Bot API -- restul functiilor din fisier sunt construite pe el. */
export async function callTelegram(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram ${method} a esuat: HTTP ${res.status} — ${body}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: raspuns neasteptat: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

/** Intoarce ultimul mesaj trimis (util cand apelantul are nevoie de message_id, ex: notificarea de aprobare). */
export async function sendTelegramMessage({ botToken, chatId }, text, replyMarkup = ACUM_KEYBOARD) {
  const chunks = splitMessage(text);
  let last;
  for (const chunk of chunks) {
    last = await callTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });
  }
  return last;
}

/** Confirma apasarea unui buton inline (altfel Telegram arata "loading" pe buton pana la timeout). */
export async function answerCallbackQuery(botToken, callbackQueryId, text) {
  await callTelegram(botToken, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

/** Editeaza un mesaj deja trimis -- folosit ca sa marcheze decizia (Aprobat/Respins) pe mesajul de cerere. */
export async function editMessageText(botToken, chatId, messageId, text) {
  await callTelegram(botToken, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'MarkdownV2' });
}

/** Sterge un mesaj -- folosit ca sa scoatem din chat mesajele in care userul a scris IDNP/serie/data. */
export async function deleteMessage(botToken, chatId, messageId) {
  await callTelegram(botToken, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

/** Scoate botul dintr-un grup -- botul nu trebuie folosit decat in chat privat (vezi CLAUDE.md). */
export async function leaveChat(botToken, chatId) {
  await callTelegram(botToken, 'leaveChat', { chat_id: chatId });
}

/**
 * Long-poll "in miniatura": intoarce update-urile noi (mesaje primite de bot) de la
 * offset incoace. `timeout: 0` -- vrem raspuns imediat (short poll), nu long-polling,
 * pentru ca rulam intr-un job scurt de CI, nu intr-un proces persistent.
 */
export async function getTelegramUpdates({ botToken }, offset) {
  const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
  if (offset != null) url.searchParams.set('offset', String(offset));
  url.searchParams.set('timeout', '0');
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram getUpdates a esuat: HTTP ${res.status} — ${body}`);
  }
  const data = await res.json();
  if (!data.ok || !Array.isArray(data.result)) {
    throw new Error(`Telegram getUpdates: raspuns neasteptat: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.result;
}

/**
 * Inregistreaza lista de comenzi in meniul nativ Telegram (butonul "Menu" de langa
 * campul de text) -- apel unic, nu trebuie rulat la fiecare mesaj/deploy, doar cand se
 * schimba lista de comenzi. `scope` optional -- `{ type: 'chat', chat_id }` seteaza o
 * lista diferita doar pentru un chat anume (proprietarul vede mai putine comenzi decat
 * restul lumii, vezi scripts/set-commands.mjs).
 */
export async function setMyCommands(botToken, commands, scope) {
  await callTelegram(botToken, 'setMyCommands', scope ? { commands, scope } : { commands });
}
