// Client minimal Telegram Bot API -- fetch nativ, zero dependente.

import { splitMessage } from './format.js';

// Tastatura persistenta (reply keyboard, NU inline) atasata la fiecare mesaj trimis de bot
// -- userul apasa butonul in loc sa scrie manual "/acum". Textul butonului trebuie sa fie
// EXACT o comanda din TRIGGER_COMMANDS (src/live.js) -- Telegram trimite inapoi ca mesaj
// text chiar eticheta butonului, nu un cod separat (asta e diferenta fata de un inline
// keyboard cu callback_data), deci webhook-ul o proceseaza prin acelasi flux ca orice
// comanda scrisa de mana, fara cod nou. `is_persistent` -- ramane vizibila dupa ce e
// apasata o data, nu dispare dupa primul tap.
const ACUM_KEYBOARD = {
  keyboard: [[{ text: '/acum' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export async function sendTelegramMessage({ botToken, chatId }, text) {
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
        reply_markup: ACUM_KEYBOARD,
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
