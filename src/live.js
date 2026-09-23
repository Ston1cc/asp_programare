// Interogare LIVE (nu din state/cache) + construirea mesajului de raspuns pentru comanda
// "/acum". Extras separat ca sa fie refolosit atat de webhook-ul Vercel (raspuns instant)
// cat si, daca e nevoie, dintr-un script local.

import { buildCategories, DEFAULT_VEHICLE } from './config.js';
import { fetchCategoryDates } from './asp.js';
import { filterWithinHorizon, buildLiveNowMessage, escapeMarkdownV2 } from './format.js';

// Orice varianta scurta, fara sa fim pretentiosi cu userul care scrie de pe telefon.
export const TRIGGER_COMMANDS = new Set(['/acum', '/live', '/status', '/check']);

// Raspunsul "/acum" trebuie sa incapa sub maxDuration (30s, vezi api/telegram-webhook.js)
// -- spre deosebire de verificarea periodica (secvential, fara presiune de timp), aici
// interogam toate categoriile IN PARALEL, cu retry mai scurt, plus un cache per-apel
// (vezi asp.js) care evita sa cerem de mai multe ori acelasi service ID / aceeasi lista
// de locatii.
const FAST_FETCH_OPTIONS = { retryDelays: [1500], timeoutMs: 6000 };

/**
 * Interogheaza toate categoriile LIVE (in paralel) si construieste mesajul de raspuns.
 * `person.vehicle`, optional (proprietarul din .env nu are acest camp -- ramane implicit
 * BMechanical, comportamentul de dinainte de optiunea de vehicul; guestii il seteaza la
 * inregistrare, vezi registration.js) -- alege categoria practica (manuala/automata).
 * `categories`, optional -- implicit toate cele construite din vehiculul persoanei;
 * apelantul poate trece un subset deja filtrat de /setari (src/prefs.js), fara ca
 * live.js sa stie nimic despre preferinte. `targetDate`, optional -- trecuta mai departe
 * la buildLiveNowMessage (marcheaza ✅ zilele care respecta tinta "Până la").
 */
export async function buildLiveReply(person, { now = new Date(), categories, targetDate = null } = {}) {
  const effectiveCategories = categories ?? buildCategories(person.vehicle ?? DEFAULT_VEHICLE);
  const cache = new Map();
  const settled = await Promise.allSettled(
    effectiveCategories.map((category) => fetchCategoryDates(category, person, { fetchOptions: FAST_FETCH_OPTIONS, cache })),
  );

  const categoryResults = [];
  const errors = [];
  settled.forEach((result, i) => {
    const category = effectiveCategories[i];
    if (result.status === 'fulfilled') {
      categoryResults.push({ category, dates: filterWithinHorizon(result.value, now) });
    } else {
      errors.push([category.label, result.reason.message]);
    }
  });

  let message = buildLiveNowMessage({ categoryResults, now, targetDate });
  if (errors.length > 0) {
    message += `\n\n⚠️ ${escapeMarkdownV2(`${errors.length}/${effectiveCategories.length} categorii n-au putut fi citite acum.`)}`;
  }

  return { message, categoryResults, errors };
}
