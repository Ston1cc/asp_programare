// Mesajul pentru /status (doar admin): starea checker-ului, a limitei ASP si a invitatilor,
// ca sa nu mai trebuiasca citite logurile GitHub. Pur -- primeste datele deja adunate de
// webhook (Redis) si intoarce textul MarkdownV2; nu face I/O.

import { escapeMarkdownV2, formatBlockUntil, formatDateHuman, getLocalParts } from './format.js';

// Checker-ul ruleaza orar; peste atat fara nicio rulare inseamna ca GitHub `schedule` a
// intarziat sau ca ceva e stricat -- exact semnalul pe care /status trebuie sa-l faca vizibil.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function hhmm(date) {
  const { hour, minute } = getLocalParts(date);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function agoLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `acum ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `acum ${h} h` : `acum ${h} h ${m} min`;
}

function line(icon, text) {
  return `${icon} ${escapeMarkdownV2(text)}`;
}

/** "tot activ" sau doar ce e oprit -- scurt, ca sa incapa intr-o linie. */
export function summarizePrefs(prefs) {
  const off = [];
  if (!prefs.teoretic) off.push('teoretic');
  if (!prefs.practic) off.push('practic');
  if (!prefs.obisnuit) off.push('obișnuit');
  if (!prefs.urgent) off.push('urgent');
  const names = { radautanu: 'Rădăuțanu', ieasilor: 'Ieșilor', salcamilor: 'Salcâmilor' };
  for (const [id, label] of Object.entries(names)) {
    if (prefs.locations[id] === false) off.push(`practic ${label}`);
  }
  const parts = [off.length === 0 ? 'toate categoriile active' : `oprit: ${off.join(', ')}`];
  if (prefs.before) parts.push(`doar până la ${formatDateHuman(prefs.before)}`);
  return parts.join(' · ');
}

/**
 * owner  = status:owner din Redis ({ lastRun, aspDaily, rateLimitedUntil, consecutiveFailures }) sau null
 * guests = status:guests ({ at, checked, skipped, sent, failed }) sau null
 * counts = { approved, registered, notifyOff, pending }
 * ownerBlockedUntil = Date | null -- blocarea /acum pentru IDNP-ul adminului (getAspBlock)
 */
export function buildStatusMessage({ now = new Date(), owner, guests, counts, ownerBlockedUntil, prefs }) {
  const lines = [`📊 *${escapeMarkdownV2('Status')}*`, ''];

  // --- Checker ---
  if (owner?.lastRun) {
    const last = new Date(owner.lastRun);
    const age = now.getTime() - last.getTime();
    lines.push(line('⏱', `Checker: ultima rulare ${hhmm(last)} (${agoLabel(age)})`));
    if (age > STALE_AFTER_MS) {
      lines.push(line('⚠️', 'Nu a mai rulat de peste 3 ore — GitHub a întârziat programarea sau ceva e stricat.'));
    }
    const count = owner.aspDaily?.count ?? 0;
    lines.push(line('🔌', `Cereri ASP azi (UTC): ${count}`));
    const until = owner.rateLimitedUntil ? new Date(owner.rateLimitedUntil) : null;
    lines.push(
      until && until > now
        ? line('🚦', `Limită ASP: ACTIVĂ până la ${formatBlockUntil(until, now)}`)
        : line('🚦', 'Limită ASP: nu'),
    );
    if (owner.consecutiveFailures > 0) {
      lines.push(line('⚠️', `Eșecuri consecutive la citire: ${owner.consecutiveFailures}`));
    }
  } else {
    lines.push(line('⏱', 'Checker: nicio rulare înregistrată încă (apare după următoarea rulare).'));
  }
  lines.push(
    ownerBlockedUntil
      ? line('📨', `/acum pentru tine: blocat până la ${formatBlockUntil(ownerBlockedUntil, now)}`)
      : line('📨', '/acum pentru tine: liber'),
  );

  // --- Invitati ---
  lines.push('');
  lines.push(
    line(
      '👥',
      `Invitați: ${counts.approved} aprobați · ${counts.registered} înregistrați · ${counts.notifyOff} cu notificările oprite · ${counts.pending} în așteptare`,
    ),
  );
  if (guests?.at) {
    const at = new Date(guests.at);
    lines.push(
      line(
        '📬',
        `Ultima rulare notificări ${hhmm(at)} (${agoLabel(now.getTime() - at.getTime())}): ${guests.checked} verificați, ${guests.skipped} săriți, ${guests.sent} mesaje, ${guests.failed} eșuați`,
      ),
    );
  } else {
    lines.push(line('📬', 'Notificări invitați: nicio rulare înregistrată încă.'));
  }

  // --- Setari ---
  lines.push('');
  lines.push(line('⚙️', `Setările tale: ${summarizePrefs(prefs)}`));
  return lines.join('\n');
}
