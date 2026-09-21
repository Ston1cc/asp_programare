// Webhook Telegram, gazduit pe Vercel -- raspuns aproape instant la "/acum" (spre
// deosebire de varianta cu polling pe GitHub Actions, care avea un plafon de ~5 minute).
// Telegram trimite update-ul direct aici de indata ce userul scrie botului, deci nu mai
// e nevoie de offset/state -- fiecare update e livrat o singura data, procesat pe loc.

import { loadConfig } from '../src/config.js';
import { TRIGGER_COMMANDS, buildLiveReply } from '../src/live.js';
import { sendTelegramMessage } from '../src/telegram.js';
import { escapeMarkdownV2 } from '../src/format.js';

export const config = { maxDuration: 30 };

// Cooldown intre doua verificari live, ca sa nu bombardam ASP daca cineva apasa "/acum"
// repetat (dublu-tap, retry de client etc). Best-effort: traieste doar cat instanta
// serverless ramane "calda" intre invocari -- Vercel de obicei o pastreaza minute bune,
// deci acopera cazul real (impacientare), fara sa garanteze protectie absoluta la un
// atac deliberat (nu e nevoia curenta).
const COOLDOWN_MS = 45_000;
let lastCheckAt = 0;

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
        const now = Date.now();
        const elapsed = now - lastCheckAt;
        if (elapsed < COOLDOWN_MS) {
          const waitSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
          await sendTelegramMessage(
            cfg.telegram,
            escapeMarkdownV2(`⏳ Ai verificat recent — mai așteaptă ${waitSec}s.`),
          );
        } else {
          lastCheckAt = now;
          const { message: reply } = await buildLiveReply(cfg.person);
          await sendTelegramMessage(cfg.telegram, reply);
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
