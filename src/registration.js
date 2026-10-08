// Flux conversational (3 pasi) prin care o persoana ALTA decat proprietarul botului isi
// introduce propriile date (IDNP, serie+numar buletin, data eliberarii) ca sa poata
// interoga ASP in numele ei. Starea intre pasi vine din/pleaca in src/userStore.js
// (`pending:<chatId>`) -- webhook-ul e stateless intre invocari, deci starea NU poate
// trai doar in memorie.
//
// Escaparea textului urmeaza exact conventia din format.js (vezi CLAUDE.md): fiecare
// fragment de text simplu trece prin escapeMarkdownV2 INAINTE de a fi impachetat in
// caractere de markup literale (`*`) -- niciodata backslash-uri scrise de mana.

import { escapeMarkdownV2 } from './format.js';

export const REGISTER_COMMANDS = new Set(['/inregistrare', '/start']);
export const DELETE_COMMAND = '/sterge';
export const HELP_COMMAND = '/help';
export const LIST_USERS_COMMAND = '/utilizatori';
export const REVOKE_COMMAND = '/revoca';
export const LIST_REQUESTS_COMMAND = '/cereri';
export const NOTIFY_COMMAND = '/notificari';
export const STATUS_COMMAND = '/status';

// /sterge cere confirmare: e un buton din tastatura, un tap gresit nu trebuie sa stearga datele.
export const DELETE_CONFIRM_PROMPT = `🗑️ ${escapeMarkdownV2(
  'Sigur vrei să-ți ștergi datele (IDNP, serie, dată), setările și notificările automate? Va trebui să te reînregistrezi.',
)}`;
export const DELETE_DONE_MESSAGE = `🗑️ ${escapeMarkdownV2('Datele tale au fost șterse (și notificările automate).')}`;
export const DELETE_CANCELLED_MESSAGE = escapeMarkdownV2('Anulat — datele tale au rămas.');
export const DELETE_CONFIRM_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🗑️ Da, șterge', callback_data: 'del:yes' },
      { text: 'Anulează', callback_data: 'del:no' },
    ],
  ],
};

// Raspunsurile la /notificari spun mereu si ce se intampla ACUM si cum se schimba -- cerinta
// explicita: faptul ca notificarile pot fi oprite trebuie sa fie evident, nu ascuns.
export const NOTIFY_ON_MESSAGE = `🔔 ${escapeMarkdownV2(
  'Notificări pornite: primești automat alerte când apar date mai devreme + un rezumat zilnic la 07:30. Apasă din nou /notificari ca să le oprești.',
)}`;
export const NOTIFY_OFF_MESSAGE = `🔕 ${escapeMarkdownV2(
  'Notificări oprite. /acum merge în continuare. Apasă din nou /notificari ca să le pornești.',
)}`;
export const NOTIFY_NEEDS_REGISTRATION_MESSAGE = escapeMarkdownV2(
  'Notificările se trimit pe datele tale — mai întâi apasă /inregistrare.',
);

// Cifra de control IDNP: ponderi 7,3,1 repetate pe primele 12 cifre, suma mod 10 trebuie
// sa egaleze cifra 13. Filtreaza typo-uri (cifre transpuse etc.) inainte sa ajunga la ASP.
function idnpChecksumValid(digits) {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(digits[i]) * weights[i % 3];
  }
  return sum % 10 === Number(digits[12]);
}

function validateIdnp(text) {
  const v = text.trim();
  return /^\d{13}$/.test(v) && idnpChecksumValid(v) ? v : null;
}

function validateSeria(text) {
  const v = text.trim().toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9]{6,12}$/.test(v) ? v : null;
}

// Accepta "DD.MM.YYYY" sau "YYYY-MM-DD" -- formatul pe care oamenii il scriu de pe
// buletin vs formatul ISO cerut de loadConfig/asp.js.
function parseIssueDate(text) {
  const v = text.trim();
  let year, month, day;
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const human = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (iso) {
    [, year, month, day] = iso;
  } else if (human) {
    [, day, month, year] = human;
  } else {
    return null;
  }
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  const valid =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 1990 && y <= 2100;
  if (!valid) return null;
  return `${year}-${month}-${day}T00:00:00`;
}

function promptIdnp() {
  return `Scrie *${escapeMarkdownV2('IDNP-ul tau (13 cifre).')}*`;
}
function promptSeria() {
  return `Acum scrie *${escapeMarkdownV2('seria și numărul buletinului (ex: AB1234567).')}*`;
}
function promptData() {
  return `Și *${escapeMarkdownV2('data eliberării buletinului (ex: 01.01.2020).')}*`;
}

export function startRegistrationPrompt() {
  const intro = escapeMarkdownV2(
    'Nu te cunosc încă. Ca să verific ASP în numele tău (nu al proprietarului botului), ' +
      'am nevoie de 3 date. Sunt criptate și stocate 90 de zile pe un server Redis extern ' +
      '(nu în acest chat) — proprietarul botului are acces tehnic la ele, dar mesajele ' +
      'tale cu datele sunt șterse din chat imediat după ce le citesc, ca să nu rămână la ' +
      'vedere. Le trimit doar către eservicii.gov.md, ca să interoghez calendarul în ' +
      'numele tău. Poți oricând să le ștergi cu /sterge.',
  );
  return {
    pending: { step: 'idnp' },
    reply: `👋 ${intro}\n\n${promptIdnp()}`,
  };
}

/**
 * Avanseaza un pas din inregistrare. `pending` = starea curenta ({ step, ...raspunsuri
 * anterioare }), `text` = mesajul brut trimis de user pentru pasul curent.
 * Intoarce { reply, pending } daca mai sunt pasi, { reply, person } daca s-a terminat
 * (gata de salvat), sau { reply, cancelled: true } daca userul a scris o comanda in loc
 * de raspunsul asteptat (altfel ar fi validata gresit ca "IDNP invalid" etc. -- vezi
 * CLAUDE.md, problema semnalata la audit).
 */
export function advanceRegistration(pending, text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('/')) {
    return {
      reply: escapeMarkdownV2(
        'Înregistrare anulată — scrie din nou comanda dacă ai vrut altceva (ex: /acum, /inregistrare).',
      ),
      cancelled: true,
    };
  }

  const step = pending.step;

  if (step === 'idnp') {
    const idnp = validateIdnp(text);
    if (!idnp) {
      const err = escapeMarkdownV2('IDNP invalid — trebuie 13 cifre, cu cifra de control corectă. Încearcă din nou.');
      return { reply: `❌ ${err}\n\n${promptIdnp()}`, pending };
    }
    return { reply: promptSeria(), pending: { step: 'seria', idnp } };
  }

  if (step === 'seria') {
    const seria = validateSeria(text);
    if (!seria) {
      const err = escapeMarkdownV2('Format invalid — litere + cifre, fără spații (ex: AB1234567). Încearcă din nou.');
      return { reply: `❌ ${err}\n\n${promptSeria()}`, pending };
    }
    return { reply: promptData(), pending: { ...pending, step: 'dataEliberarii', seria } };
  }

  if (step === 'dataEliberarii') {
    const issueDate = parseIssueDate(text);
    if (!issueDate) {
      const err = escapeMarkdownV2('Dată invalidă — folosește DD.MM.YYYY sau YYYY-MM-DD. Încearcă din nou.');
      return { reply: `❌ ${err}\n\n${promptData()}`, pending };
    }
    return {
      reply: `✅ ${escapeMarkdownV2(
        'Gata! Poți verifica acum cu /acum. De acum primești și notificări automate (alerte când apar date mai devreme + rezumat zilnic la 07:30). Le poți opri oricând cu /notificari.',
      )}`,
      person: { idnp: pending.idnp, seriaAndNumber: pending.seria, issueDate },
    };
  }

  // Stare neasteptata (nu ar trebui sa se intample) -- repornim inregistrarea curat.
  return startRegistrationPrompt();
}

// --- Acces: mesajele pentru fluxul de aprobare manuala de catre proprietar -----------
//
// Orice chat strain trebuie aprobat explicit de proprietar INAINTE sa i se ceara IDNP-ul
// -- vezi CLAUDE.md. Aceste functii construiesc doar textul; starea (`access:<chatId>`
// in Redis) e gestionata in userStore.js, orchestrarea in api/telegram-webhook.js.

export const ACCESS_PENDING_MESSAGE = `⏳ ${escapeMarkdownV2('Cererea ta e încă în așteptare — proprietarul trebuie s-o aprobe.')}`;
export const ACCESS_DENIED_MESSAGE = `❌ ${escapeMarkdownV2('Cererea ta de acces a fost respinsă.')}`;
export const ACCESS_REQUESTED_MESSAGE = `👋 ${escapeMarkdownV2('Cererea ta de acces a fost trimisă proprietarului botului. Revino după ce e aprobată.')}`;

/** Mesajul trimis PROPRIETARULUI cand apare o cerere noua, cu butoane Aproba/Respinge atasate separat. */
export function formatAccessRequestText({ chatId, name, username }) {
  const label = username ? `${name || '(fără nume)'} (@${username})` : name || `chat ${chatId}`;
  return [
    `🔔 *${escapeMarkdownV2('Cerere nouă de acces la bot')}*`,
    '',
    escapeMarkdownV2(label),
    escapeMarkdownV2(`chat_id: ${chatId}`),
  ].join('\n');
}

/** Un rand compact per cerere, pentru /cereri -- include statusul, spre deosebire de formatAccessRequestText (doar pentru cererea noua, inca fara status decis). */
export function formatAccessListLine(record) {
  const emoji = record.status === 'approved' ? '✅' : record.status === 'denied' ? '❌' : '⏳';
  const label = record.username ? `${record.name || '(fără nume)'} (@${record.username})` : record.name || `chat ${record.chatId}`;
  const when = record.requestedAt ? record.requestedAt.slice(0, 16).replace('T', ' ') : '?';
  return escapeMarkdownV2(`${emoji} ${label} — chat_id ${record.chatId} — cerut ${when}`);
}

/** Randul adaugat la mesajul de mai sus dupa ce proprietarul a decis (edit in Telegram). */
export function buildAccessDecisionLine(status) {
  return status === 'approved' ? `✅ ${escapeMarkdownV2('Aprobat')}` : `❌ ${escapeMarkdownV2('Respins')}`;
}

/** Mesajul trimis SOLICITANTULUI dupa decizia proprietarului. */
export function buildAccessDecisionMessage(status) {
  return status === 'approved'
    ? `✅ ${escapeMarkdownV2('Ai fost aprobat! Scrie /inregistrare ca să-ți introduci datele.')}`
    : ACCESS_DENIED_MESSAGE;
}

function cmdLine(cmd, desc) {
  return `*${escapeMarkdownV2(cmd)}* — ${escapeMarkdownV2(desc)}`;
}

/**
 * Mesajul pentru /help -- adaptat starii chat-ului, ca sa nu listeze comenzi care nu se
 * aplica (proprietarul n-are ce face cu /inregistrare sau /sterge, datele lui vin din
 * .env, nu din Redis).
 */
export function buildHelpMessage({ isOwner, hasPerson, needsApproval }) {
  const lines = [`🤖 *${escapeMarkdownV2('Comenzi disponibile:')}*`, ''];
  if (isOwner) {
    lines.push(cmdLine('/acum', 'verifică live cele mai apropiate date la examen'));
    lines.push(cmdLine('/status', 'starea checker-ului, limita ASP și invitații'));
    lines.push(cmdLine('/setari', 'alege ce categorii/filiale/dată-țintă apar la /acum și în alerte'));
    lines.push(cmdLine('/utilizatori', 'listează persoanele cu acces aprobat'));
    lines.push(cmdLine('/cereri', 'listează toate cererile de acces (în așteptare + decise)'));
    lines.push(cmdLine('/revoca <chat_id>', 'revocă accesul unei persoane'));
  } else if (hasPerson) {
    lines.push(cmdLine('/acum', 'verifică live cele mai apropiate date, cu datele tale salvate'));
    lines.push(cmdLine('/setari', 'alege ce categorii/filiale/dată-țintă apar la /acum și în alerte'));
    lines.push(cmdLine('/notificari', 'pornește/oprește notificările automate (alerte + rezumat 07:30)'));
    lines.push(cmdLine('/sterge', 'șterge datele tale salvate (IDNP/serie/dată)'));
  } else if (needsApproval) {
    // Nu aratam /inregistrare aici -- inainte de aprobare, comanda doar retrimite/
    // reaminteste cererea de acces, nu porneste inregistrarea (vezi CLAUDE.md).
    lines.push(escapeMarkdownV2('Scrie orice mesaj ca să trimiți o cerere de acces proprietarului botului.'));
  } else {
    lines.push(cmdLine('/inregistrare', 'introdu IDNP/serie/dată ca să poți folosi botul în numele tău'));
  }
  lines.push(cmdLine('/help', 'acest mesaj'));
  return lines.join('\n');
}
