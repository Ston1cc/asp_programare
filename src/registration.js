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

function validateIdnp(text) {
  const v = text.trim();
  return /^\d{13}$/.test(v) ? v : null;
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
  return `Acum scrie *${escapeMarkdownV2('seria și numărul buletinului (ex: EA0039316).')}*`;
}
function promptData() {
  return `Și *${escapeMarkdownV2('data eliberării buletinului (ex: 16.05.2025).')}*`;
}

export function startRegistrationPrompt() {
  const intro = escapeMarkdownV2(
    'Nu te cunosc încă. Ca să verific ASP în numele tău (nu al proprietarului botului), ' +
      'am nevoie de 3 date — nu se salvează nicăieri altundeva decât aici, poți oricând ' +
      'să le ștergi cu /sterge.',
  );
  return {
    pending: { step: 'idnp' },
    reply: `👋 ${intro}\n\n${promptIdnp()}`,
  };
}

/**
 * Avanseaza un pas din inregistrare. `pending` = starea curenta ({ step, ...raspunsuri
 * anterioare }), `text` = mesajul brut trimis de user pentru pasul curent.
 * Intoarce { reply, pending } daca mai sunt pasi, sau { reply, person } daca s-a
 * terminat (gata de salvat).
 */
export function advanceRegistration(pending, text) {
  const step = pending.step;

  if (step === 'idnp') {
    const idnp = validateIdnp(text);
    if (!idnp) {
      const err = escapeMarkdownV2('IDNP invalid — trebuie 13 cifre. Încearcă din nou.');
      return { reply: `❌ ${err}\n\n${promptIdnp()}`, pending };
    }
    return { reply: promptSeria(), pending: { step: 'seria', idnp } };
  }

  if (step === 'seria') {
    const seria = validateSeria(text);
    if (!seria) {
      const err = escapeMarkdownV2('Format invalid — litere + cifre, fără spații (ex: EA0039316). Încearcă din nou.');
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
      reply: `✅ ${escapeMarkdownV2('Gata! Poți verifica acum cu /acum.')}`,
      person: { idnp: pending.idnp, seriaAndNumber: pending.seria, issueDate },
    };
  }

  // Stare neasteptata (nu ar trebui sa se intample) -- repornim inregistrarea curat.
  return startRegistrationPrompt();
}

function cmdLine(cmd, desc) {
  return `*${escapeMarkdownV2(cmd)}* — ${escapeMarkdownV2(desc)}`;
}

/**
 * Mesajul pentru /help -- adaptat starii chat-ului, ca sa nu listeze comenzi care nu se
 * aplica (proprietarul n-are ce face cu /inregistrare sau /sterge, datele lui vin din
 * .env, nu din Redis).
 */
export function buildHelpMessage({ isOwner, hasPerson }) {
  const lines = [`🤖 *${escapeMarkdownV2('Comenzi disponibile:')}*`, ''];
  if (isOwner) {
    lines.push(cmdLine('/acum', 'verifică live cele mai apropiate date la examen'));
  } else if (hasPerson) {
    lines.push(cmdLine('/acum', 'verifică live cele mai apropiate date, cu datele tale salvate'));
    lines.push(cmdLine('/sterge', 'șterge datele tale salvate (IDNP/serie/dată)'));
  } else {
    lines.push(cmdLine('/inregistrare', 'introdu IDNP/serie/dată ca să poți folosi botul în numele tău'));
  }
  lines.push(cmdLine('/help', 'acest mesaj'));
  return lines.join('\n');
}
