// Interogare LIVE (nu din state/cache) + construirea mesajului de raspuns pentru comanda
// "/acum". Extras separat ca sa fie refolosit atat de webhook-ul Vercel (raspuns instant)
// cat si, daca e nevoie, dintr-un script local.

import { fetchCategoryDates, RateLimitError } from './asp.js';
import { filterCurrentAndNextMonth, buildLiveNowMessage, buildAspBlockedMessage, escapeMarkdownV2 } from './format.js';
import {
  DEFAULT_PREFS,
  selectCategories,
  filterCategoryResultsByPrefs,
  buildTargetNote,
  NO_CATEGORIES_MESSAGE,
} from './prefs.js';

// Orice varianta scurta, fara sa fim pretentiosi cu userul care scrie de pe telefon.
// `/status` NU mai e aici: e comanda adminului (starea checker-ului), nu un alias de /acum.
export const TRIGGER_COMMANDS = new Set(['/acum', '/live', '/check']);

// Raspunsul "/acum" trebuie sa incapa sub maxDuration (30s, vezi api/telegram-webhook.js)
// -- spre deosebire de verificarea periodica (secvential, fara presiune de timp), aici
// interogam toate categoriile IN PARALEL, cu retry mai scurt, plus un cache per-apel
// (vezi asp.js) care evita sa cerem de mai multe ori acelasi service ID / aceeasi lista
// de locatii.
const FAST_FETCH_OPTIONS = { retryDelays: [1500], timeoutMs: 6000 };

/**
 * Interogheaza LIVE (in paralel) categoriile alese in /setari si construieste mesajul de
 * raspuns. Citeste doar categoriile selectate -- mai putine cereri din cota ASP -- si taie
 * zilele de dupa tinta ("Pana la"), daca exista.
 */
export async function buildLiveReply(person, { now = new Date(), prefs = DEFAULT_PREFS } = {}) {
  const categories = selectCategories(prefs);
  if (categories.length === 0) {
    return { message: NO_CATEGORIES_MESSAGE, categoryResults: [], errors: [], rateLimitedUntil: null };
  }

  const cache = new Map();
  const settled = await Promise.allSettled(
    categories.map((category) => fetchCategoryDates(category, person, { fetchOptions: FAST_FETCH_OPTIONS, cache })),
  );

  const fetched = [];
  const errors = [];
  let rateLimitedUntil = null;
  settled.forEach((result, i) => {
    const category = categories[i];
    if (result.status === 'fulfilled') {
      fetched.push({ category, dates: filterCurrentAndNextMonth(result.value, now) });
    } else if (result.reason instanceof RateLimitError) {
      rateLimitedUntil = result.reason.until;
    } else {
      errors.push([category.label, result.reason.message]);
    }
  });

  // Limita ASP (429) nu e un esec de citire ca oricare altul -- apelantul salveaza
  // `rateLimitedUntil` (userStore.setAspBlock) ca urmatoarele /acum sa nu mai loveasca ASP,
  // iar utilizatorul primeste motivul real + ora de reset, nu un vag "8/8 n-au putut fi citite".
  if (rateLimitedUntil && fetched.length === 0) {
    return { message: buildAspBlockedMessage({ until: rateLimitedUntil, now }), categoryResults: [], errors, rateLimitedUntil };
  }

  const categoryResults = filterCategoryResultsByPrefs(prefs, fetched);
  const lines = buildLiveNowMessage({ categoryResults, now }).split('\n');
  const note = buildTargetNote(prefs);
  // buildLiveNowMessage: [titlu, oras, '', ...] -- nota de tinta vine sub oras.
  if (note) lines.splice(2, 0, note);
  let message = lines.join('\n');
  const unread = categories.length - fetched.length;
  if (unread > 0) {
    message += `\n\n⚠️ ${escapeMarkdownV2(`${unread}/${categories.length} categorii n-au putut fi citite acum.`)}`;
  }

  return { message, categoryResults, errors, rateLimitedUntil };
}
