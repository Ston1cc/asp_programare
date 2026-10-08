// Setarile (/setari) ale proprietarului, pentru checker-ul din CI (src/index.js). Setarile
// stau in Redis, accesibil doar de pe Vercel (REDIS_URL e write-only, nu poate fi copiat in
// GitHub), deci CI-ul le cere aici, cu acelasi `NOTIFY_SECRET` ca api/notify-guests.js.
// Raspunsul nu contine date personale -- doar boolean-uri + o data-tinta.

import { normalizePrefs } from '../src/prefs.js';
import { isValidSecret } from '../src/secret.js';
import { getPrefs } from '../src/userStore.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!isValidSecret(token, process.env.NOTIFY_SECRET)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const prefs = normalizePrefs(await getPrefs(process.env.TELEGRAM_CHAT_ID));
    res.status(200).json({ ok: true, prefs });
  } catch (err) {
    console.error('Eroare in owner-prefs:', err);
    res.status(500).json({ ok: false, error: 'eroare interna' });
  }
}
