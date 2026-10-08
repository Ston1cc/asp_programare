// Notificarile automate ale invitatilor (alerte + rezumat 07:30). Functie Vercel apelata
// din .github/workflows/check.yml dupa verificarea proprietarului, cu un secret de tip
// Bearer. Ruleaza AICI (nu in CI) pentru ca datele invitatilor sunt criptate cu
// USER_DATA_KEY, care ramane doar in Vercel -- nu e copiata in GitHub.

import { loadConfig } from '../src/config.js';
import { runGuests } from '../src/guests.js';
import { isValidSecret } from '../src/secret.js';
import { tryAcquireGuestRunLock, releaseGuestRunLock, setStatus } from '../src/userStore.js';

// CI trimite aici state/slots.json al proprietarului; pastram doar campurile de care are
// nevoie /status (nimic din zilele libere sau din date personale).
function pickOwnerStatus(body) {
  if (!body || typeof body !== 'object') return null;
  return {
    lastRun: typeof body.lastRun === 'string' ? body.lastRun : null,
    lastHeartbeatDate: typeof body.lastHeartbeatDate === 'string' ? body.lastHeartbeatDate : null,
    rateLimitedUntil: typeof body.rateLimitedUntil === 'string' ? body.rateLimitedUntil : null,
    consecutiveFailures: Number.isFinite(body.consecutiveFailures) ? body.consecutiveFailures : 0,
    aspDaily:
      body.aspDaily && typeof body.aspDaily === 'object'
        ? { date: String(body.aspDaily.date ?? ''), count: Number(body.aspDaily.count) || 0 }
        : null,
  };
}

// Verificarea e secventiala per invitat (8 cereri ASP fiecare) -- 120s acopera confortabil
// cativa invitati; peste asta ar trebui paralelizat.
export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!isValidSecret(token, process.env.NOTIFY_SECRET)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  let locked = false;
  try {
    locked = await tryAcquireGuestRunLock();
    if (!locked) {
      res.status(409).json({ ok: false, error: 'o rulare e deja in curs' });
      return;
    }
    const cfg = loadConfig();
    const now = new Date();

    // Pentru /status. Best-effort: o eroare aici nu trebuie sa opreasca notificarile.
    const ownerStatus = pickOwnerStatus(req.body);
    if (ownerStatus?.lastRun) {
      try {
        await setStatus('owner', ownerStatus);
      } catch (err) {
        console.error('Nu am putut salva status:owner:', err.message);
      }
    }

    const summary = await runGuests({ telegram: cfg.telegram, now, cache: new Map() });
    try {
      await setStatus('guests', { at: now.toISOString(), ...summary });
    } catch (err) {
      console.error('Nu am putut salva status:guests:', err.message);
    }
    res.status(200).json({ ok: true, ...summary });
  } catch (err) {
    console.error('Eroare in notify-guests:', err);
    res.status(500).json({ ok: false, error: 'eroare interna' });
  } finally {
    if (locked) {
      try {
        await releaseGuestRunLock();
      } catch (err) {
        console.error('Nu am putut elibera lock-ul:', err.message);
      }
    }
  }
}
