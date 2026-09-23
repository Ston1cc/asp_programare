// Client minimal Telegram Bot API -- fetch nativ, zero dependente.

import { splitMessage } from './format.js';

// Tastaturi persistente (reply keyboard, NU inline) atasate la mesajele trimise de bot --
// userul apasa un buton in loc sa scrie manual comanda. Textul butonului trebuie sa fie
// EXACT o comanda recunoscuta (TRIGGER_COMMANDS in src/live.js sau REGISTER_COMMAND in
// api/telegram-webhook.js) -- Telegram trimite inapoi ca mesaj text chiar eticheta
// butonului, nu un cod separat (asta e diferenta fata de un inline keyboard cu
// callback_data), deci webhook-ul o proceseaza prin acelasi flux ca orice comanda scrisa
// de mana, fara cod nou. `is_persistent` -- ramane vizibila dupa ce e apasata o data.
//
// Trei variante, alese de webhook dupa starea chat-ului:
//   ACUM_KEYBOARD       -- proprietarul botului (are mereu date, din .env)
//   REGISTERED_KEYBOARD -- alta persoana care si-a salvat deja datele
//   REGISTER_KEYBOARD   -- alta persoana necunoscuta botului -- singurul buton util e
//                          cel care porneste introducerea datelor
export const ACUM_KEYBOARD = {
  keyboard: [[{ text: '/acum' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const REGISTERED_KEYBOARD = {
  keyboard: [[{ text: '/acum' }], [{ text: '/sterge' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const REGISTER_KEYBOARD = {
  keyboard: [[{ text: '/inregistrare' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export async function sendTelegramMessage({ botToken, chatId }, text, replyMarkup = ACUM_KEYBOARD) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        reply_markup: replyMarkup,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram sendMessage a esuat: HTTP ${res.status} — ${body}`);
    }
  }
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
