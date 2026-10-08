// Notificari automate pentru invitatii aprobati: acelasi lucru ca pentru proprietar (alerta
// cand apare o zi mai devreme / noua + rezumat zilnic la 07:30), dar pe datele FIECARUIA
// (IDNP-ul lui, cota ASP a lui) si cu state-ul lui in Redis. Rulat de api/notify-guests.js
// (Vercel), apelat din .github/workflows/check.yml dupa verificarea proprietarului -- NU din
// src/index.js: datele invitatilor sunt criptate cu USER_DATA_KEY, care ramane doar in
// Vercel (nu e copiata in GitHub), iar CI-ul ramane fara dependente.
//
// `userStore.js` e importat dinamic ca acest modul sa poata fi incarcat si fara `redis`.

import { checkPerson } from './check.js';
import { EMPTY_STATE } from './state.js';
import { buildRateLimitMessage, escapeMarkdownV2 } from './format.js';
import { sendTelegramMessage, REGISTERED_KEYBOARD } from './telegram.js';

// Optiunea de oprire trebuie sa fie vizibila in FIECARE mesaj automat, nu doar la inceput.
const OPT_OUT_FOOTER = `🔕 ${escapeMarkdownV2('Nu mai vrei notificări automate? Apasă /notificari')}`;
const FIRST_RUN_FOOTER =
  `ℹ️ ${escapeMarkdownV2(
    'De acum primești automat alerte când apar date mai devreme, plus un rezumat zilnic la 07:30. ' +
      'Le poți opri oricând cu /notificari (/acum merge în continuare).',
  )}`;

function withFooter(message, footer) {
  return `${message}\n\n${footer}`;
}

async function runGuest({ store, telegram, guest, now, cache }) {
  const { chatId } = guest;

  if (!(await store.isNotifyEnabled(chatId))) return 'skipped';
  const person = await store.getPerson(chatId);
  if (!person) return 'skipped'; // aprobat, dar inca neinregistrat
  if (await store.getAspBlock(person.idnp)) return 'skipped'; // cota ASP a lui e epuizata

  const state = { ...EMPTY_STATE(), ...((await store.getGuestState(chatId)) ?? {}) };
  const result = await checkPerson({ person, state, now, cache });

  const messages = [];
  if (result.rateLimit) {
    // Aceeasi blocare pe care o foloseste si /acum -- si o singura notificare pe blocare:
    // rularile urmatoare sar peste invitat pana expira.
    await store.setAspBlock(person.idnp, result.rateLimit.until);
    messages.push(buildRateLimitMessage({ until: result.rateLimit.until, countToday: 0, now }));
  }
  messages.push(...result.messages);

  for (let i = 0; i < messages.length; i++) {
    const footer = i === 0 && result.isFirstEverRun ? FIRST_RUN_FOOTER : OPT_OUT_FOOTER;
    await sendTelegramMessage({ botToken: telegram.botToken, chatId }, withFooter(messages[i], footer), REGISTERED_KEYBOARD);
  }

  // Salvat DUPA trimitere: daca Telegram a refuzat (eroare trecatoare), state-ul vechi ramane
  // si alerta se reincearca la urmatoarea rulare, in loc sa se piarda.
  await store.setGuestState(chatId, { ...result.nextState, lastRun: now.toISOString() });
  return messages.length;
}

/**
 * Ruleaza verificarea pentru toti invitatii aprobati. Intoarce { checked, skipped, sent,
 * failed }. NU inchide conexiunea Redis: ruleaza intr-o functie Vercel (api/notify-guests.js)
 * a carei instanta calda e folosita si de webhook -- inchiderea ar rupe o cerere concurenta.
 */
export async function runGuests({ telegram, now = new Date(), cache = new Map() }) {
  const store = await import('./userStore.js');
  const summary = { checked: 0, skipped: 0, sent: 0, failed: 0 };

  const guests = (await store.listApprovedAccess()).filter((g) => String(g.chatId) !== String(telegram.chatId));
  for (const guest of guests) {
    // try/catch PER invitat: unul cu probleme (ex. a blocat botul -> Telegram 403) nu
    // trebuie sa opreasca restul.
    try {
      const outcome = await runGuest({ store, telegram, guest, now, cache });
      if (outcome === 'skipped') summary.skipped += 1;
      else {
        summary.checked += 1;
        summary.sent += outcome;
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`invitat ${guest.chatId}: ${err.message}`);
    }
  }
  console.log(`invitati: ${summary.checked} verificati, ${summary.skipped} sariti, ${summary.sent} mesaje, ${summary.failed} esuati.`);
  return summary;
}
