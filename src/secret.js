// Comparare de secrete in timp constant -- folosita de ambele endpoint-uri publice
// (api/telegram-webhook.js si api/cron-check.js) ca sa verifice un token trimis de un
// apelant de incredere (Telegram, respectiv cron-job.org) inainte sa faca orice altceva.
// Un `!==` obisnuit ar lasa un atacator sa deduca secretul caracter cu caracter din cat
// de repede raspunde compararea (timing attack). Lungimi diferite tratate explicit:
// timingSafeEqual arunca in loc sa intoarca false daca buffer-ele n-au aceeasi lungime.

import { timingSafeEqual } from 'node:crypto';

export function isValidSecret(received, expected) {
  if (!received || !expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
