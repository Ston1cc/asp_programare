// Webhook Telegram, gazduit pe Vercel -- raspuns aproape instant la "/acum" (spre
// deosebire de varianta cu polling pe GitHub Actions, care avea un plafon de ~5 minute).
// Telegram trimite update-ul direct aici de indata ce userul scrie botului, deci nu mai
// e nevoie de offset/state -- fiecare update e livrat o singura data, procesat pe loc.
//
// Trei categorii de chat-uri:
//   - proprietarul (cfg.telegram.chatId, din .env) -- foloseste mereu datele personale
//     din .env, comportament neschimbat de la inceput.
//   - un chat aprobat de proprietar -- si-a introdus datele (IDNP/serie/data eliberarii)
//     prin fluxul din src/registration.js; stocate criptat per chat_id in
//     src/userStore.js, NU in .env si NU alaturi de datele proprietarului.
//   - orice alt chat -- necunoscut botului pana proprietarul ii aproba manual cererea de
//     acces (buton inline Aproba/Respinge) -- vezi CLAUDE.md pentru motivul acestui pas:
//     fara el, oricine putea sa-si inregistreze IDNP-ul, facand din proprietar operator
//     de date personale pentru straini, fara control.

import { isValidSecret } from '../src/secret.js';
import { loadConfig } from '../src/config.js';
import { TRIGGER_COMMANDS, buildLiveReply } from '../src/live.js';
import {
  sendTelegramMessage,
  answerCallbackQuery,
  editMessageText,
  deleteMessage,
  leaveChat,
  ACUM_KEYBOARD,
  REGISTERED_KEYBOARD,
  REGISTER_KEYBOARD,
} from '../src/telegram.js';
import { escapeMarkdownV2, buildAspBlockedMessage } from '../src/format.js';
import {
  SETTINGS_COMMAND,
  PREF_BEFORE_PROMPT,
  PREF_LAST_EXAM_PROMPT,
  normalizePrefs,
  togglePref,
  parsePrefDateInput,
  buildSettingsKeyboard,
  buildSettingsSummary,
} from '../src/prefs.js';
import { buildStatusMessage } from '../src/status.js';
import { buildStatsMessage } from '../src/stats.js';
import {
  REGISTER_COMMANDS,
  DELETE_COMMAND,
  DELETE_CONFIRM_PROMPT,
  DELETE_CONFIRM_KEYBOARD,
  DELETE_DONE_MESSAGE,
  DELETE_CANCELLED_MESSAGE,
  STATUS_COMMAND,
  STATS_COMMAND,
  HELP_COMMAND,
  NOTIFY_COMMAND,
  NOTIFY_ON_MESSAGE,
  NOTIFY_OFF_MESSAGE,
  NOTIFY_NEEDS_REGISTRATION_MESSAGE,
  LIST_USERS_COMMAND,
  REVOKE_COMMAND,
  LIST_REQUESTS_COMMAND,
  startRegistrationPrompt,
  advanceRegistration,
  buildHelpMessage,
  ACCESS_PENDING_MESSAGE,
  ACCESS_DENIED_MESSAGE,
  ACCESS_REQUESTED_MESSAGE,
  formatAccessRequestText,
  formatAccessListLine,
  buildAccessDecisionLine,
  buildAccessDecisionMessage,
} from '../src/registration.js';
import {
  getPerson,
  setPerson,
  deletePerson,
  getPendingRegistration,
  setPendingRegistration,
  clearPendingRegistration,
  getAccess,
  requestAccessIfNew,
  setAccessStatus,
  deleteAccess,
  listApprovedAccess,
  listAllAccess,
  tryAcquireRateLimit,
  isGlobalRateLimited,
  getAspBlock,
  setAspBlock,
  isNotifyEnabled,
  setNotifyEnabled,
  deleteGuestNotifyData,
  getPrefs,
  setPrefs,
  getStatus,
} from '../src/userStore.js';

export const config = { maxDuration: 30 };

const UNAVAILABLE_MESSAGE = `⚠️ ${escapeMarkdownV2('Serviciu temporar indisponibil — încearcă din nou peste câteva minute.')}`;

// Proprietarul NU are cooldown/rate-limit la /acum (scos la cererea lui, 21.11.2026): fiecare /acum
// face o verificare live (8 cereri ASP din cota zilnica a IDNP-ului lui). Doar ceilalti useri trec prin
// rate-limit-ul din Redis (userStore.js), per chat, ca sa nu se blocheze unii pe altii.

async function replyTo(botToken, chatId, text, keyboard) {
  await sendTelegramMessage({ botToken, chatId }, text, keyboard);
}

/**
 * Un rand de log per eveniment al unui user, cautabil dupa chat_id in logurile Vercel
 * (ex. `chat=1889741580`). NU loga niciodata textul mesajului: in pasii de inregistrare
 * contine IDNP/serie/data. Doar eticheta comenzii, starea accesului si rezultatul.
 */
function logUser(chatId, event, detail = '') {
  console.log(`[user] chat=${chatId} ${event}${detail ? ` ${detail}` : ''}`);
}

const KNOWN_COMMANDS = new Set([
  ...TRIGGER_COMMANDS,
  ...REGISTER_COMMANDS,
  HELP_COMMAND,
  DELETE_COMMAND,
  NOTIFY_COMMAND,
  SETTINGS_COMMAND,
]);

/** Eticheta sigura de logat pentru un mesaj: comanda cunoscuta, `/?` pentru alta comanda, `text` pentru rest. */
function commandLabel(text) {
  if (KNOWN_COMMANDS.has(text)) return text;
  return text.startsWith('/') ? '/?' : 'text';
}

/** Tastatura Aproba/Respinge atasata unei cereri de acces -- refolosita atat la notificarea initiala (handleGuestMessage) cat si la retrimiterea din /cereri pentru cereri ratate. */
function buildApproveKeyboard(targetChatId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Aprobă', callback_data: `approve:${targetChatId}` },
        { text: '❌ Respinge', callback_data: `deny:${targetChatId}` },
      ],
    ],
  };
}

/**
 * Textul raspunsului /acum, constient de limita zilnica ASP (HTTP 429, per IDNP): cat timp
 * IDNP-ul e blocat raspunde imediat, fara nicio cerere ASP; dupa un 429 nou, salveaza
 * blocarea ca urmatoarele /acum sa nu mai loveasca ASP. Redis e best-effort aici -- daca
 * pica, verificarea live merge oricum (doar fara memoria blocarii), ca proprietarul sa nu
 * depinda de Redis pentru /acum, ca inainte.
 */
async function liveReplyText(person, chatId, backupPerson = null) {
  // `backupPerson` = ASP_IDNP_2, doar pentru proprietar (rezerva e IDNP-ul lui, cu cota proprie; invitatii
  // n-o au). Identitatea folosita: principalul, sau rezerva daca principalul e deja blocat (429 salvat).
  let primaryBlocked = null;
  let backupBlocked = null;
  try {
    primaryBlocked = await getAspBlock(person.idnp);
    if (backupPerson) backupBlocked = await getAspBlock(backupPerson.idnp);
  } catch (err) {
    console.error('Eroare la citirea blocarii ASP (Redis):', err.message);
  }
  if (primaryBlocked && (!backupPerson || backupBlocked)) {
    // Toate identitatile disponibile sunt blocate: raspundem imediat, fara nicio cerere ASP.
    const until = backupPerson
      ? new Date(Math.min(new Date(primaryBlocked).getTime(), new Date(backupBlocked).getTime()))
      : primaryBlocked;
    logUser(chatId, 'live', `result=asp_blocked until=${new Date(until).toISOString()}`);
    return buildAspBlockedMessage({ until });
  }
  const useBackupOnly = Boolean(primaryBlocked); // aici rezerva exista si nu e blocata
  const first = useBackupOnly ? backupPerson : person;
  const second = !useBackupOnly && backupPerson && !backupBlocked ? backupPerson : null;
  const via = useBackupOnly ? 'backup' : 'primary';

  // Setarile (/setari) sunt tot best-effort: daca Redis nu raspunde, /acum arata tot, ca inainte.
  let prefs = normalizePrefs(null);
  try {
    prefs = normalizePrefs(await getPrefs(chatId));
  } catch (err) {
    console.error('Eroare la citirea setarilor (Redis):', err.message);
  }
  const { message, rateLimitedUntil, backupRateLimitedUntil } = await buildLiveReply(first, { prefs, backupPerson: second });
  // Logat cu `via`: se vede ce identitate a raspuns (si daca s-a trecut pe rezerva in timpul cererii).
  const switched = Boolean(second && rateLimitedUntil);
  logUser(
    chatId,
    'live',
    (rateLimitedUntil ? `result=asp_429 until=${new Date(rateLimitedUntil).toISOString()}` : 'result=ok') +
      ` via=${switched ? 'primary->backup' : via}`,
  );
  // Fiecare blocare se salveaza pe identitatea careia ii apartine: `first` pentru rateLimitedUntil,
  // `second` (rezerva) pentru backupRateLimitedUntil.
  const saves = [
    [first, rateLimitedUntil],
    [second, backupRateLimitedUntil],
  ];
  for (const [identity, until] of saves) {
    if (!identity || !until) continue;
    try {
      await setAspBlock(identity.idnp, until);
    } catch (err) {
      console.error('Eroare la salvarea blocarii ASP (Redis):', err.message);
    }
  }
  return message;
}

async function runOwnerLiveCheck(botToken, chatId, person, keyboard, backupPerson = null) {
  await replyTo(botToken, chatId, await liveReplyText(person, chatId, backupPerson), keyboard);
}

async function runUserLiveCheck(botToken, chatId, person, keyboard) {
  // Blocarea ASP se verifica INAINTEA rate-limit-ului pe chat: altfel primul /acum consuma slotul
  // de 45s si urmatoarele primeau "Ai verificat recent" in loc de mesajul real cu ora deblocarii.
  // Best-effort (ca in liveReplyText): daca Redis pica, continuam cu fluxul obisnuit.
  try {
    const blockedUntil = await getAspBlock(person.idnp);
    if (blockedUntil) {
      logUser(chatId, 'live', `result=asp_blocked until=${new Date(blockedUntil).toISOString()}`);
      await replyTo(botToken, chatId, buildAspBlockedMessage({ until: blockedUntil }), keyboard);
      return;
    }
  } catch (err) {
    console.error('Eroare la citirea blocarii ASP (Redis):', err.message);
  }

  try {
    const acquired = await tryAcquireRateLimit(chatId);
    if (!acquired) {
      logUser(chatId, 'live', 'result=rate_limited_chat');
      await replyTo(botToken, chatId, escapeMarkdownV2('⏳ Ai verificat recent — mai așteaptă puțin.'), keyboard);
      return;
    }
    if (await isGlobalRateLimited()) {
      logUser(chatId, 'live', 'result=rate_limited_global');
      await replyTo(botToken, chatId, escapeMarkdownV2('🚦 Botul e aglomerat chiar acum — mai încearcă peste un minut.'), keyboard);
      return;
    }
  } catch (err) {
    console.error('Eroare la rate-limit (Redis):', err.message);
    await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, keyboard);
    return;
  }
  await replyTo(botToken, chatId, await liveReplyText(person, chatId), keyboard);
}

// --- /setari: trimitere, "Pana la" (pending), callback-uri --------------------------------

async function sendSettings(botToken, chatId, errorKeyboard) {
  let prefs;
  try {
    prefs = normalizePrefs(await getPrefs(chatId));
  } catch (err) {
    console.error('Eroare la citirea setarilor (Redis):', err.message);
    await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, errorKeyboard);
    return;
  }
  await replyTo(botToken, chatId, buildSettingsSummary(), buildSettingsKeyboard(prefs));
}

// Pasii `pending` care citesc o data din /setari -> campul din prefs pe care il seteaza.
const PREF_DATE_STEPS = { prefBefore: 'before', prefLastExam: 'lastExam' };

/**
 * Raspunsul la promptul "Pana la" / "Ultimul examen" (`pending.step` din PREF_DATE_STEPS).
 * Intoarce true daca mesajul a fost tratat aici; false daca era o comanda (`/...`) -- atunci
 * cererea se anuleaza si apelantul continua sa proceseze comanda normal, in loc s-o valideze
 * ca pe o data.
 */
async function handlePrefDate(botToken, chatId, step, rawText, keyboard) {
  if (rawText.startsWith('/')) {
    await clearPendingRegistration(chatId);
    return false;
  }
  const field = PREF_DATE_STEPS[step];
  const result = parsePrefDateInput(rawText);
  if (!result.ok) {
    await replyTo(
      botToken,
      chatId,
      `❌ ${escapeMarkdownV2('Dată invalidă — folosește DD.MM.YYYY sau YYYY-MM-DD, ori 0 ca să o ștergi.')}`,
      keyboard,
    );
    return true;
  }
  const prefs = normalizePrefs(await getPrefs(chatId));
  await setPrefs(chatId, { ...prefs, [field]: result.date });
  await clearPendingRegistration(chatId);
  const done = field === 'before' ? 'Ținta' : 'Data ultimului examen';
  await replyTo(
    botToken,
    chatId,
    escapeMarkdownV2(result.date ? `✅ ${done} a fost setată. Vezi mai jos.` : `✅ ${done} a fost ștearsă.`),
    keyboard,
  );
  await sendSettings(botToken, chatId, keyboard);
  return true;
}

/**
 * /status (doar admin): starea checker-ului (trimisa de CI la api/notify-guests.js), a limitei
 * ASP, a invitatilor si setarile adminului -- ca sa nu mai trebuiasca citite logurile GitHub.
 */
async function handleOwnerStatus(cfg) {
  const { botToken, chatId } = cfg.telegram;
  const [owner, guests, all, ownerBlockedUntil, rawPrefs] = await Promise.all([
    getStatus('owner'),
    getStatus('guests'),
    listAllAccess(),
    getAspBlock(cfg.person.idnp),
    getPrefs(chatId),
  ]);
  const approved = all.filter((r) => r.status === 'approved');
  const registered = (await Promise.all(approved.map((r) => getPerson(r.chatId)))).filter(Boolean).length;
  const notifyOff = (await Promise.all(approved.map((r) => isNotifyEnabled(r.chatId)))).filter((on) => !on).length;
  const counts = {
    approved: approved.length,
    registered,
    notifyOff,
    pending: all.filter((r) => r.status === 'pending').length,
  };
  await replyTo(
    botToken,
    chatId,
    buildStatusMessage({ owner, guests, counts, ownerBlockedUntil, prefs: normalizePrefs(rawPrefs) }),
    ACUM_KEYBOARD,
  );
}

async function handleOwnerMessage(cfg, rawText, text) {
  const { botToken, chatId } = cfg.telegram;

  // Raspunsul la "📅 Până la" (setat de butonul din /setari). Citirea pending-ului e
  // best-effort: daca Redis nu raspunde, restul comenzilor adminului merg ca inainte.
  let pending = null;
  try {
    pending = await getPendingRegistration(chatId);
  } catch (err) {
    console.error('Eroare la citirea pending (owner):', err.message);
  }
  if ((pending?.step ?? '') in PREF_DATE_STEPS && (await handlePrefDate(botToken, chatId, pending.step, rawText, ACUM_KEYBOARD))) {
    return;
  }

  if (text === HELP_COMMAND) {
    await replyTo(botToken, chatId, buildHelpMessage({ isOwner: true }), ACUM_KEYBOARD);
    return;
  }

  if (text === STATS_COMMAND) {
    try {
      const owner = await getStatus('owner');
      await replyTo(
        botToken,
        chatId,
        buildStatsMessage({ stats: owner?.stats, schedule: owner?.schedule, nextIntervalSeconds: owner?.nextIntervalSeconds }),
        ACUM_KEYBOARD,
      );
    } catch (err) {
      console.error('Eroare la /statistici:', err.message);
      await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, ACUM_KEYBOARD);
    }
    return;
  }

  if (text === STATUS_COMMAND) {
    try {
      await handleOwnerStatus(cfg);
    } catch (err) {
      console.error('Eroare la /status:', err.message);
      await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, ACUM_KEYBOARD);
    }
    return;
  }

  if (text === SETTINGS_COMMAND) {
    await sendSettings(botToken, chatId, ACUM_KEYBOARD);
    return;
  }

  if (text === LIST_USERS_COMMAND) {
    let list = [];
    try {
      list = await listApprovedAccess();
    } catch (err) {
      await replyTo(botToken, chatId, escapeMarkdownV2(`Eroare la citirea listei: ${err.message}`), ACUM_KEYBOARD);
      return;
    }
    const body =
      list.length === 0
        ? escapeMarkdownV2('Niciun utilizator aprobat momentan.')
        : list
            .map((u) =>
              escapeMarkdownV2(`• ${u.name || '(fără nume)'}${u.username ? ' @' + u.username : ''} — chat_id ${u.chatId}`),
            )
            .join('\n');
    await replyTo(botToken, chatId, `👥 *${escapeMarkdownV2('Utilizatori aprobați')}*\n\n${body}`, ACUM_KEYBOARD);
    return;
  }

  if (text === LIST_REQUESTS_COMMAND) {
    let all = [];
    try {
      all = await listAllAccess();
    } catch (err) {
      await replyTo(botToken, chatId, escapeMarkdownV2(`Eroare la citirea cererilor: ${err.message}`), ACUM_KEYBOARD);
      return;
    }
    if (all.length === 0) {
      await replyTo(botToken, chatId, escapeMarkdownV2('Nicio cerere înregistrată momentan.'), ACUM_KEYBOARD);
      return;
    }
    const pending = all.filter((r) => r.status === 'pending');
    const decided = all.filter((r) => r.status !== 'pending');
    const lines = [`📋 *${escapeMarkdownV2('Toate cererile')}*`, ''];
    if (pending.length > 0) {
      lines.push(escapeMarkdownV2(`⏳ În așteptare (${pending.length}):`));
      lines.push(...pending.map(formatAccessListLine));
      lines.push('');
    }
    if (decided.length > 0) {
      lines.push(escapeMarkdownV2(`Decise (${decided.length}):`));
      lines.push(...decided.map(formatAccessListLine));
    }
    await replyTo(botToken, chatId, lines.join('\n'), ACUM_KEYBOARD);

    // Fiecare cerere inca in asteptare e retrimisa separat, cu butoanele Aproba/Respinge --
    // altfel lista ar arata o cerere pending pe care proprietarul n-ar avea cum sa o mai
    // decida daca a ratat notificarea initiala (SET NX o trimite o singura data, la creare).
    for (const r of pending) {
      try {
        await sendTelegramMessage({ botToken, chatId }, formatAccessRequestText(r), buildApproveKeyboard(r.chatId));
      } catch (err) {
        console.error('Eroare la retrimiterea cererii pentru actiune:', err.message);
      }
    }
    return;
  }

  if (text.startsWith(`${REVOKE_COMMAND} `)) {
    const targetChatId = rawText.slice(REVOKE_COMMAND.length).trim();
    await deleteAccess(targetChatId);
    await deletePerson(targetChatId);
    await clearPendingRegistration(targetChatId);
    await deleteGuestNotifyData(targetChatId);
    await replyTo(botToken, chatId, escapeMarkdownV2(`Acces revocat pentru chat_id ${targetChatId}.`), ACUM_KEYBOARD);
    return;
  }

  if (TRIGGER_COMMANDS.has(text)) {
    await runOwnerLiveCheck(botToken, chatId, cfg.person, ACUM_KEYBOARD, cfg.backupPerson);
  }
}

async function handleGuestMessage(cfg, message, rawText, text) {
  const { botToken, chatId: ownerId } = cfg.telegram;
  const chatId = message.chat.id;

  // Botul nu trebuie folosit in grupuri -- oricine din grup ar vedea IDNP-ul scris de
  // altcineva si ar putea rula /acum sau /sterge pe datele lui. Iese imediat, inaintea
  // oricarei alte procesari.
  if (message.chat.type !== 'private') {
    logUser(chatId, 'left_group', `type=${message.chat.type}`);
    try {
      await leaveChat(botToken, chatId);
    } catch (err) {
      console.error('Eroare la leaveChat:', err.message);
    }
    return;
  }

  // /help si /sterge raman disponibile oricui, indiferent de starea de acces -- iesirea
  // din confuzie, respectiv dreptul de a-si sterge datele, nu trebuie sa astepte aprobare.
  if (text === HELP_COMMAND) {
    let hasPerson = false;
    let needsApproval = true;
    try {
      const [person, accessForHelp] = await Promise.all([getPerson(chatId), getAccess(chatId)]);
      hasPerson = Boolean(person);
      needsApproval = accessForHelp?.status !== 'approved';
    } catch (err) {
      // Best-effort -- /help trebuie sa raspunda si daca Redis e jos, presupunem
      // varianta cea mai restrictiva (mai sigura: nu promite butoane care n-ar functiona).
      console.error('Eroare la citirea starii pentru /help:', err.message);
    }
    const keyboard = hasPerson ? REGISTERED_KEYBOARD : REGISTER_KEYBOARD;
    await replyTo(botToken, chatId, buildHelpMessage({ isOwner: false, hasPerson, needsApproval }), keyboard);
    return;
  }

  // /sterge nu mai sterge direct: e un buton din tastatura, un tap gresit n-ar trebui sa
  // distruga datele. Stergerea reala se face in handleDeleteCallback, dupa confirmare.
  if (text === DELETE_COMMAND) {
    await replyTo(botToken, chatId, DELETE_CONFIRM_PROMPT, DELETE_CONFIRM_KEYBOARD);
    return;
  }

  let access;
  try {
    access = await getAccess(chatId);
  } catch (err) {
    console.error('Eroare la citirea accesului:', err.message);
    await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, REGISTER_KEYBOARD);
    return;
  }

  logUser(chatId, 'msg', `cmd=${commandLabel(text)} access=${access?.status ?? 'none'}`);

  if (access?.status !== 'approved') {
    if (access?.status === 'denied') {
      await replyTo(botToken, chatId, ACCESS_DENIED_MESSAGE, REGISTER_KEYBOARD);
      return;
    }
    if (access?.status === 'pending') {
      await replyTo(botToken, chatId, ACCESS_PENDING_MESSAGE, REGISTER_KEYBOARD);
      return;
    }

    // Nicio cerere inca -- o cream o singura data (SET NX in userStore), ca un strain sa
    // nu poata bombarda proprietarul cu notificari repetate doar retrimitand mesajul.
    const meta = {
      chatId: String(chatId),
      name: [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || null,
      username: message.from?.username || null,
    };
    let created = false;
    try {
      created = await requestAccessIfNew(chatId, meta);
    } catch (err) {
      console.error('Eroare la crearea cererii de acces:', err.message);
      await replyTo(botToken, chatId, UNAVAILABLE_MESSAGE, REGISTER_KEYBOARD);
      return;
    }
    if (created) {
      try {
        await sendTelegramMessage({ botToken, chatId: ownerId }, formatAccessRequestText(meta), buildApproveKeyboard(chatId));
      } catch (err) {
        console.error('Eroare la notificarea proprietarului:', err.message);
      }
    }
    await replyTo(botToken, chatId, ACCESS_REQUESTED_MESSAGE, REGISTER_KEYBOARD);
    return;
  }

  // Inaintea starii `pending`: ca /help, nu trebuie inghitit de validarea unui pas.
  if (text === NOTIFY_COMMAND) {
    const person = await getPerson(chatId);
    if (!person) {
      await replyTo(botToken, chatId, NOTIFY_NEEDS_REGISTRATION_MESSAGE, REGISTER_KEYBOARD);
      return;
    }
    const nowEnabled = !(await isNotifyEnabled(chatId));
    await setNotifyEnabled(chatId, nowEnabled);
    await replyTo(botToken, chatId, nowEnabled ? NOTIFY_ON_MESSAGE : NOTIFY_OFF_MESSAGE, REGISTERED_KEYBOARD);
    return;
  }

  if (text === SETTINGS_COMMAND) {
    await sendSettings(botToken, chatId, await guestKeyboardFor(chatId));
    return;
  }

  // De aici incolo: acces aprobat -- comportamentul de dinainte de audit-ul de securitate.
  let pending = await getPendingRegistration(chatId);
  if (pending) logUser(chatId, 'pending', `step=${pending.step ?? 'registration'}`);
  // "Pana la" din /setari foloseste aceeasi cheie `pending`, dar NU e un pas de inregistrare --
  // il tratam separat, altfel ar fi validat ca IDNP. O comanda scrisa in loc de raspuns anuleaza
  // cererea (handlePrefDate intoarce false) si trece mai departe ca o comanda obisnuita.
  if ((pending?.step ?? '') in PREF_DATE_STEPS) {
    const person = await getPerson(chatId);
    if (await handlePrefDate(botToken, chatId, pending.step, rawText, person ? REGISTERED_KEYBOARD : REGISTER_KEYBOARD)) return;
    pending = null;
  }
  if (pending) {
    const result = advanceRegistration(pending, rawText);
    if (result.cancelled) {
      await clearPendingRegistration(chatId);
      await replyTo(botToken, chatId, result.reply, REGISTER_KEYBOARD);
      return;
    }
    // rawText a fost o incercare (valida sau nu) de IDNP/serie/data -- stergem mesajul
    // userului indiferent de rezultat, ca datele scrise sa nu ramana la vedere in
    // istoricul chat-ului.
    try {
      await deleteMessage(botToken, chatId, message.message_id);
    } catch (err) {
      console.error('Eroare la stergerea mesajului cu date:', err.message);
    }
    if (result.person) {
      await setPerson(chatId, result.person);
      await clearPendingRegistration(chatId);
      await replyTo(botToken, chatId, result.reply, REGISTERED_KEYBOARD);
    } else {
      await setPendingRegistration(chatId, result.pending);
      await replyTo(botToken, chatId, result.reply, REGISTER_KEYBOARD);
    }
    return;
  }

  if (REGISTER_COMMANDS.has(text)) {
    const { pending: newPending, reply } = startRegistrationPrompt();
    await setPendingRegistration(chatId, newPending);
    await replyTo(botToken, chatId, reply, REGISTER_KEYBOARD);
    return;
  }

  if (TRIGGER_COMMANDS.has(text)) {
    const person = await getPerson(chatId);
    if (person) {
      await runUserLiveCheck(botToken, chatId, person, REGISTERED_KEYBOARD);
    } else {
      const { pending: newPending, reply } = startRegistrationPrompt();
      await setPendingRegistration(chatId, newPending);
      await replyTo(botToken, chatId, reply, REGISTER_KEYBOARD);
    }
    return;
  }

  // Acces aprobat, fara pas in curs si nicio comanda cunoscuta (ex. text liber): botul nu
  // raspunde nimic. Logat explicit, ca "nu primesc nimic" sa se poata verifica in loguri.
  logUser(chatId, 'ignored', `cmd=${commandLabel(text)}`);
}

/** Tastatura persistenta potrivita unui chat de invitat (inregistrat sau nu). */
async function guestKeyboardFor(chatId) {
  try {
    return (await getPerson(chatId)) ? REGISTERED_KEYBOARD : REGISTER_KEYBOARD;
  } catch {
    return REGISTER_KEYBOARD;
  }
}

/**
 * Butoanele din /setari (`pref:<cale>`). Spre deosebire de approve:/deny: (doar proprietarul),
 * sunt permise oricarui chat cu acces -- si e sigur pentru ca payload-ul NU poarta niciodata un
 * chat_id tinta: actiunea se aplica mereu lui `cq.from.id`, identitatea confirmata de Telegram,
 * deci nimeni nu poate modifica setarile altcuiva apasand un buton.
 */
async function handlePrefCallback(cfg, cq, path) {
  const { botToken, chatId: ownerId } = cfg.telegram;
  const fromId = cq.from?.id;
  if (fromId == null) {
    await answerCallbackQuery(botToken, cq.id, '');
    return;
  }
  const isOwner = String(fromId) === String(ownerId);
  if (!isOwner && (await getAccess(fromId))?.status !== 'approved') {
    await answerCallbackQuery(botToken, cq.id, 'Nu ai acces.');
    return;
  }

  if (path === 'before' || path === 'lastexam') {
    await setPendingRegistration(fromId, { step: path === 'before' ? 'prefBefore' : 'prefLastExam' });
    await answerCallbackQuery(botToken, cq.id, '');
    await replyTo(
      botToken,
      fromId,
      path === 'before' ? PREF_BEFORE_PROMPT : PREF_LAST_EXAM_PROMPT,
      isOwner ? ACUM_KEYBOARD : await guestKeyboardFor(fromId),
    );
    return;
  }

  const prefs = togglePref(normalizePrefs(await getPrefs(fromId)), path);
  await setPrefs(fromId, prefs);
  await answerCallbackQuery(botToken, cq.id, '');
  if (cq.message?.chat?.id != null && cq.message?.message_id != null) {
    try {
      await editMessageText(botToken, cq.message.chat.id, cq.message.message_id, buildSettingsSummary(), buildSettingsKeyboard(prefs));
    } catch (err) {
      // "message is not modified" (path necunoscut / dublu-tap) -- inofensiv.
      console.error('Eroare la editarea setarilor:', err.message);
    }
  }
}

/**
 * Confirmarea /sterge (`del:yes` / `del:no`). Permisa oricui, fara aprobare -- dreptul de a-si
 * sterge datele nu trebuie sa astepte pe nimeni; si doar pe `cq.from.id`, ca la setari.
 */
async function handleDeleteCallback(cfg, cq, choice) {
  const { botToken } = cfg.telegram;
  const fromId = cq.from?.id;
  if (fromId == null) {
    await answerCallbackQuery(botToken, cq.id, '');
    return;
  }

  const editResult = async (text) => {
    if (cq.message?.chat?.id == null || cq.message?.message_id == null) return;
    try {
      await editMessageText(botToken, cq.message.chat.id, cq.message.message_id, text);
    } catch (err) {
      console.error('Eroare la editarea confirmarii /sterge:', err.message);
    }
  };

  if (choice !== 'yes') {
    await answerCallbackQuery(botToken, cq.id, 'Anulat.');
    await editResult(DELETE_CANCELLED_MESSAGE);
    return;
  }

  await deletePerson(fromId);
  await clearPendingRegistration(fromId);
  await deleteGuestNotifyData(fromId);
  await answerCallbackQuery(botToken, cq.id, 'Șters.');
  await editResult(DELETE_DONE_MESSAGE);
  await replyTo(botToken, fromId, escapeMarkdownV2('Poți reîncepe oricând cu /inregistrare.'), REGISTER_KEYBOARD);
}

async function handleCallbackQuery(cfg, cq) {
  const { botToken, chatId: ownerId } = cfg.telegram;

  const data = String(cq.data || '');
  logUser(cq.from?.id, 'callback', `data=${data}`);
  if (data.startsWith('pref:')) {
    await handlePrefCallback(cfg, cq, data.slice('pref:'.length));
    return;
  }
  if (data.startsWith('del:')) {
    await handleDeleteCallback(cfg, cq, data.slice('del:'.length));
    return;
  }

  if (String(cq.from?.id) !== String(ownerId)) {
    // Cineva a apasat un buton dar nu e proprietarul -- nu avem incredere orbeste in
    // continutul payload-ului, doar in identitatea confirmata de Telegram (`from.id`).
    await answerCallbackQuery(botToken, cq.id, 'Doar proprietarul poate decide.');
    return;
  }

  const [action, targetChatId] = String(cq.data || '').split(':');
  if (action !== 'approve' && action !== 'deny') {
    await answerCallbackQuery(botToken, cq.id, '');
    return;
  }

  const status = action === 'approve' ? 'approved' : 'denied';
  const existing = await getAccess(targetChatId);
  await setAccessStatus(targetChatId, status);
  await answerCallbackQuery(botToken, cq.id, status === 'approved' ? 'Aprobat.' : 'Respins.');

  if (cq.message?.chat?.id != null && cq.message?.message_id != null) {
    const updatedText = `${formatAccessRequestText({
      chatId: targetChatId,
      name: existing?.name,
      username: existing?.username,
    })}\n\n${buildAccessDecisionLine(status)}`;
    try {
      await editMessageText(botToken, cq.message.chat.id, cq.message.message_id, updatedText);
    } catch (err) {
      console.error('Eroare la editarea mesajului de cerere:', err.message);
    }
  }

  try {
    await replyTo(botToken, targetChatId, buildAccessDecisionMessage(status), REGISTER_KEYBOARD);
  } catch (err) {
    console.error('Eroare la notificarea solicitantului:', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  // Telegram trimite acest header pe fiecare cerere de webhook cand secret_token e setat
  // la setWebhook -- singura protectie ca nu oricine poate declansa un fetch live doar
  // stiind URL-ul (public prin natura unui webhook).
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!isValidSecret(secret, process.env.TELEGRAM_WEBHOOK_SECRET)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const cfg = loadConfig();

    const callbackQuery = req.body?.callback_query;
    if (callbackQuery) {
      await handleCallbackQuery(cfg, callbackQuery);
    } else {
      const message = req.body?.message;
      if (message?.chat?.id != null && typeof message.text === 'string') {
        const chatId = message.chat.id;
        const rawText = message.text.trim();
        const text = rawText.toLowerCase();

        if (String(chatId) === String(cfg.telegram.chatId)) {
          await handleOwnerMessage(cfg, rawText, text);
        } else {
          await handleGuestMessage(cfg, message, rawText, text);
        }
      }
    }
  } catch (err) {
    // Nu lasam eroarea sa propage catre Telegram ca 5xx -- ar declansa retry-uri repetate
    // ale ACELUIASI update. O logam si raspundem 200 oricum.
    console.error('Eroare in webhook:', err);
  }

  res.status(200).json({ ok: true });
}
