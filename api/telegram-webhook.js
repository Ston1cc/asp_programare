// Webhook Telegram, gazduit pe Vercel -- raspuns aproape instant la "/acum" (spre
// deosebire de varianta cu polling pe GitHub Actions, care avea un plafon de ~5 minute).
// Telegram trimite update-ul direct aici de indata ce userul scrie botului, deci nu mai
// e nevoie de offset/state -- fiecare update e livrat o singura data, procesat pe loc.

import { loadConfig } from '../src/config.js';
import { TRIGGER_COMMANDS, buildLiveReply } from '../src/live.js';
import { sendTelegramMessage } from '../src/telegram.js';

export const config = { maxDuration: 30 };

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

    // Doar mesaje din chatul configurat -- ignoram orice altcineva ar scrie botului.
    if (message && String(message.chat.id) === String(cfg.telegram.chatId)) {
      const text = (message.text ?? '').trim().toLowerCase();
      if (TRIGGER_COMMANDS.has(text)) {
        const { message: reply } = await buildLiveReply(cfg.person);
        await sendTelegramMessage(cfg.telegram, reply);
      }
    }
  } catch (err) {
    // Nu lasam eroarea sa propage catre Telegram ca 5xx -- ar declansa retry-uri repetate
    // ale ACELUIASI update. O logam si raspundem 200 oricum.
    console.error('Eroare in webhook:', err);
  }

  res.status(200).json({ ok: true });
}
