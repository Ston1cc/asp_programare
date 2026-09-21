// Interogare LIVE (nu din state/cache) + construirea mesajului de raspuns pentru comanda
// "/acum". Extras separat ca sa fie refolosit atat de webhook-ul Vercel (raspuns instant)
// cat si, daca e nevoie, dintr-un script local.

import { CATEGORIES } from './config.js';
import { fetchCategoryDates } from './asp.js';
import { filterCurrentAndNextMonth, buildLiveNowMessage, escapeMarkdownV2 } from './format.js';

// Orice varianta scurta, fara sa fim pretentiosi cu userul care scrie de pe telefon.
export const TRIGGER_COMMANDS = new Set(['/acum', '/live', '/status', '/check']);

/** Interogheaza toate categoriile LIVE si construieste mesajul de raspuns. */
export async function buildLiveReply(person, now = new Date()) {
  const categoryResults = [];
  const errors = [];

  for (const category of CATEGORIES) {
    try {
      const dates = await fetchCategoryDates(category, person);
      categoryResults.push({ category, dates: filterCurrentAndNextMonth(dates, now) });
    } catch (err) {
      errors.push([category.label, err.message]);
    }
  }

  let message = buildLiveNowMessage({ categoryResults, now });
  if (errors.length > 0) {
    message += `\n\n⚠️ ${escapeMarkdownV2(`${errors.length}/${CATEGORIES.length} categorii n-au putut fi citite acum.`)}`;
  }

  return { message, categoryResults, errors };
}
