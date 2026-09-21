// Client minimal Telegram Bot API -- fetch nativ, zero dependente.

import { splitMessage } from './format.js';

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
