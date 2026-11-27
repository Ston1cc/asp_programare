// Acces cu plata (manuala, o singura data). Activ DOAR daca PAYMENT_INSTRUCTIONS e setat in
// mediu -- fara el, botul se comporta exact ca inainte (aprobare manuala, fara plata), deci
// putem deploya codul fara sa pornim plata pana cand totul e pregatit.
//
// Fluxul: un chat nou primeste instructiunile de plata (access status `unpaid`, proprietarul NU
// e notificat inca) -> userul trimite poza/captura chitantei sau scrie /platit (status
// `pending`, proprietarul primeste dovada + butoanele Aproba/Respinge) -> proprietarul
// verifica in contul lui si apasa Aproba (status `approved`) -> pasul de acord (src/consent.js)
// -> /inregistrare. Doar text si constante: fara dependente de Redis, importabil oriunde.

import { escapeMarkdownV2 } from './format.js';

export const PAID_COMMAND = '/platit';

const DEFAULT_PRICE_MDL = 50;

export function isPaywallEnabled(env = process.env) {
  return Boolean(env.PAYMENT_INSTRUCTIONS?.trim());
}

export function getPriceMdl(env = process.env) {
  const n = Number(env.PAYMENT_PRICE_MDL);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PRICE_MDL;
}

/** Instructiunile din env: `\n` literal (cum se scrie intr-o variabila de mediu) devine rand nou. */
function instructionsLines(env) {
  return env.PAYMENT_INSTRUCTIONS.trim().replaceAll('\\n', '\n').split('\n').map((l) => escapeMarkdownV2(l));
}

/** Trimis unui chat fara acces (sau cu plata respinsa): pretul, ce primeste, cum plateste, cum confirma. */
export function buildPaymentInstructionsMessage(env = process.env) {
  return [
    `💳 *${escapeMarkdownV2(`Acces la notificări — ${getPriceMdl(env)} MDL, plată unică`)}*`,
    '',
    escapeMarkdownV2(
      'Primești automat pe Telegram alerte când apar zile libere mai devreme la examen, un rezumat zilnic la 07:30 și comanda /acum.',
    ),
    '',
    `*${escapeMarkdownV2('Cum plătești:')}*`,
    ...instructionsLines(env),
    '',
    escapeMarkdownV2(
      `După plată, trimite aici o poză sau o captură a chitanței (sau scrie ${PAID_COMMAND}). Accesul se activează după ce confirm plata.`,
    ),
    '',
    escapeMarkdownV2('Detalii despre datele tale: /confidentialitate'),
  ].join('\n');
}

export const PAYMENT_PROOF_RECEIVED_MESSAGE = `🧾 ${escapeMarkdownV2(
  'Am primit confirmarea plății. O verific și îți scriu aici imediat ce accesul e activat.',
)}`;

export const PAYMENT_PENDING_MESSAGE = `⏳ ${escapeMarkdownV2('Plata ta e în curs de verificare — îți scriu aici când e confirmată.')}`;

export const PAYMENT_DENIED_MESSAGE = `❌ ${escapeMarkdownV2(
  'Nu am putut confirma plata. Dacă ai plătit, trimite din nou chitanța (poză sau captură) sau scrie /platit.',
)}`;

export const PAYMENT_APPROVED_MESSAGE = `✅ ${escapeMarkdownV2(
  'Plata a fost confirmată, mulțumesc! Scrie /inregistrare ca să-ți introduci datele.',
)}`;
