// Aviz de confidentialitate + acord explicit, ceruta INAINTE ca un invitat sa-si introduca
// IDNP-ul (si inainte ca botul sa-i prelucreze orice date). Doar text si constante, fara
// dependente de Redis -- importabil si din src/guests.js.
//
// Textul descrie ce face codul in realitate (nu promite mai mult): datele se trimit la ASP la
// fiecare verificare, sunt criptate in Redis cu retentie de 90 de zile (PERSON_TTL_SECONDS din
// userStore.js -- tine-le sincronizate) si administratorul le poate citi tehnic (are cheia).
// Cand schimbi textul in mod material, creste CONSENT_VERSION: toti invitatii vor trebui sa
// accepte din nou (guests.js nu mai prelucreaza pana atunci, webhook-ul cere acordul).
//
// NU e text validat juridic -- de revizuit cu un jurist inainte de a lua bani pe serviciu.

import { escapeMarkdownV2 } from './format.js';

export const CONSENT_VERSION = '2026-11-27';
export const PRIVACY_COMMAND = '/confidentialitate';

const RETENTION_DAYS = 90;

/** Acordul salvat e valid doar pentru versiunea curenta a textului. */
export function hasValidConsent(record) {
  return record?.version === CONSENT_VERSION;
}

const DEFAULT_CONTACT = '@xydamian';

function contactLine(env) {
  const contact = env.PRIVACY_CONTACT?.trim() || DEFAULT_CONTACT;
  return `Operator: administratorul botului — contact: ${contact}.`;
}

/** Textul complet al avizului (pentru /confidentialitate si ca parte din promptul de acord). */
export function buildPrivacyText(env = process.env) {
  const p = (text) => escapeMarkdownV2(text);
  return [
    `🔒 *${p('Datele tale — ce fac cu ele')}*`,
    '',
    p(
      'Ca să verific calendarul ASP în numele tău și să-ți trimit notificări, am nevoie de: IDNP, seria și numărul buletinului, data eliberării. Păstrez și identificatorul chatului tău de Telegram și numele afișat.',
    ),
    '',
    p('• Scop: doar interogarea calendarului ASP (eservicii.gov.md) și trimiterea notificărilor tale. Datele sunt transmise către ASP la fiecare verificare — fără asta serviciul nu poate funcționa.'),
    p('• Nu le dau altcuiva și nu le vând.'),
    p(
      `• Stocare: criptat (AES-256) într-o bază de date Redis, procesate pe Vercel; mesajul tău cu datele este șters din chat după ce îl citesc. Se șterg automat după ${RETENTION_DAYS} de zile sau imediat prin /sterge.`,
    ),
    p('• Acces: ca administrator al botului dețin cheia de criptare, deci le pot citi tehnic; nu o fac decât pentru a rezolva o problemă.'),
    p('• Poți retrage acordul oricând cu /sterge (șterge datele și oprește notificările). Fără acord nu pot oferi serviciul.'),
    p(`• ${contactLine(env)}`),
  ].join('\n');
}

export const CONSENT_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '✅ Sunt de acord', callback_data: 'consent:yes' },
      { text: '❌ Nu sunt de acord', callback_data: 'consent:no' },
    ],
  ],
};

/** Promptul de acord: avizul complet + intrebarea; butoanele se ataseaza la trimitere. */
export function buildConsentPrompt(env = process.env) {
  return `${buildPrivacyText(env)}\n\n${escapeMarkdownV2('Ești de acord cu prelucrarea datelor în acest scop?')}`;
}

export const CONSENT_GIVEN_MESSAGE = `✅ ${escapeMarkdownV2('Mulțumesc, acordul a fost salvat.')}`;

export const CONSENT_DECLINED_MESSAGE = `🛑 ${escapeMarkdownV2(
  'Am înțeles — nu salvez nicio dată. Dacă te răzgândești, scrie orice mesaj ca să revii la acest pas.',
)}`;

/** Mesaj catre invitatii existenti, trimis o singura data, cand textul de acord apare dupa ce erau deja inregistrati. */
export const CONSENT_RENEWAL_INTRO = `ℹ️ ${escapeMarkdownV2(
  'Am adăugat un aviz de confidențialitate. Notificările automate sunt oprite până îți dai acordul mai jos.',
)}`;
