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
import { normalizePrefs } from './prefs.js';
import { buildRateLimitMessage, escapeMarkdownV2 } from './format.js';
import { sendTelegramMessage, REGISTERED_KEYBOARD, BOOKING_KEYBOARD } from './telegram.js';
import { hasValidConsent, buildConsentPrompt, CONSENT_KEYBOARD, CONSENT_RENEWAL_INTRO } from './consent.js';

// Optiunea de oprire trebuie sa fie vizibila in FIECARE mesaj automat, nu doar la inceput.
const OPT_OUT_FOOTER = `🔕 ${escapeMarkdownV2('Nu mai vrei notificări automate? Apasă /notificari')}`;
const FIRST_RUN_FOOTER =
  `ℹ️ ${escapeMarkdownV2(
    'De acum primești automat alerte când apar date mai devreme, plus un rezumat zilnic la 07:30. ' +
      'Le poți opri oricând cu /notificari (/acum merge în continuare).',
  )}`;

// Invitatii se verifica la cel putin 65 min (cadenta de dinainte), indiferent cat de des ruleaza
// bucla din CI (10 min pentru proprietar): fiecare invitat are cota lui ASP (~181-200 cereri/zi),
// iar cu toate cele 8 categorii active la 10 min ar fi 1152 cereri/zi si si-ar epuiza-o la
// prinz. Toleranta de 1 min: iteratiile CI au jitter de cateva secunde, fara ea un invitat la
// 64:58 min ar astepta inca o iteratie. Cum bucla bate din 10 in 10 min, cadenta efectiva e ~70.
export const GUEST_MIN_INTERVAL_MS = 65 * 60 * 1000;
const GUEST_INTERVAL_TOLERANCE_MS = 60 * 1000;

/** True daca invitatul n-a mai fost verificat de destul timp (sau niciodata). */
export function guestDueForCheck(state, now) {
  const last = state?.lastRun ? Date.parse(state.lastRun) : NaN;
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= GUEST_MIN_INTERVAL_MS - GUEST_INTERVAL_TOLERANCE_MS;
}

function withFooter(message, footer) {
  return `${message}\n\n${footer}`;
}

async function runGuest({ store, telegram, guest, now, cache }) {
  const { chatId } = guest;

  // Motivul fiecarui "skipped" se logheaza cu chat_id (fara date personale), ca sa se vada de ce
  // un invitat n-a fost verificat -- altfel rezumatul "N sariti" nu spune care si de ce.
  const skip = (why) => {
    console.log(`[guest] chat=${chatId} skipped=${why}`);
    return 'skipped';
  };

  if (!(await store.isNotifyEnabled(chatId))) return skip('notify_off');
  const person = await store.getPerson(chatId);
  if (!person) return skip('not_registered'); // aprobat, dar inca neinregistrat

  // Fara acord valid (retras prin /sterge sau aviz nou) nu prelucram datele lui: nicio cerere
  // ASP. Cerem acordul o singura data la 3 zile, ca un invitat existent sa afle de ce s-au oprit.
  if (!hasValidConsent(await store.getConsent(chatId))) {
    if (await store.markConsentPrompted(chatId)) {
      await sendTelegramMessage(
        { botToken: telegram.botToken, chatId },
        `${CONSENT_RENEWAL_INTRO}\n\n${buildConsentPrompt()}`,
        CONSENT_KEYBOARD,
      );
    }
    return skip('no_consent');
  }
  if (await store.getAspBlock(person.idnp)) return skip('asp_blocked'); // cota ASP a lui e epuizata

  const state = { ...EMPTY_STATE(), ...((await store.getGuestState(chatId)) ?? {}) };
  if (!guestDueForCheck(state, now)) return skip('not_due'); // verificat acum mai putin de ~65 min
  const prefs = normalizePrefs(await store.getPrefs(chatId));
  const result = await checkPerson({ person, state, now, cache, prefs });
  console.log(
    `[guest] chat=${chatId} checked asp_429=${result.rateLimit ? `until=${new Date(result.rateLimit.until).toISOString()}` : 'no'} messages=${result.messages.length}`,
  );

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
    // Butonul de programare doar pe mesajele cu date, nu pe cel de limita ASP.
    const markup = result.messages.includes(messages[i]) ? BOOKING_KEYBOARD : REGISTERED_KEYBOARD;
    await sendTelegramMessage({ botToken: telegram.botToken, chatId }, withFooter(messages[i], footer), markup);
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
