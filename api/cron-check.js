// Checkerul periodic, gazduit pe Vercel -- apelat de un cron EXTERN (cron-job.org) la
// cadenta configurata acolo (recomandat: ~10 min), NU de Vercel Cron (pe planul Hobby
// ruleaza cel mult o data pe zi, insuficient aici) si NU de GitHub Actions (fostul
// `schedule` din .github/workflows/check.yml era doar best-effort -- vezi CLAUDE.md,
// rulari intarziate ore intregi in varf de trafic GH). Inlocuieste complet vechiul
// workflow: state-ul e acum in Redis (userStore.js), nu mai e comis in repo la fiecare
// rulare.
//
// Nucleul (fetch + diff + heartbeat) e in src/check.js, partajat cu src/index.js
// (runnerul local) -- acest fisier doar autentifica cererea, ia un lock impotriva
// rularilor suprapuse, apeleaza runCheck cu un store Redis si trimite mesajele rezultate.

import { loadConfig } from '../src/config.js';
import { EMPTY_STATE } from '../src/state.js';
import { runCheck } from '../src/check.js';
import { sendTelegramMessage } from '../src/telegram.js';
import { isValidSecret } from '../src/secret.js';
import { normalizePrefs } from '../src/prefs.js';
import {
  getCheckerState,
  setCheckerState,
  tryAcquireCheckerLock,
  releaseCheckerLock,
  getPrefs,
} from '../src/userStore.js';

export const config = { maxDuration: 120 };

// Retry mai scurt decat implicitul din asp.js (folosit de rularea locala, fara presiune
// de timp) -- la cadenta de ~10 min, o rulare blocata mult timp intarzie inutil urmatoarea.
const FETCH_OPTIONS = { retryDelays: [2000, 4000], timeoutMs: 10_000 };
// Mai mare decat pragul de 3 al rularii locale -- la interval de 10 min, 3 esecuri
// consecutive inseamna doar 30 minute, prea sensibil la un blip trecator al ASP. 6 la
// ~10 min inseamna ~1h de indisponibilitate reala inainte sa alertam proprietarul.
const FAILURE_THRESHOLD = 6;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!isValidSecret(token, process.env.CRON_SECRET)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  let acquired = false;
  try {
    acquired = await tryAcquireCheckerLock();
  } catch (err) {
    console.error('Eroare la lock-ul checkerului (Redis):', err.message);
    // 200, nu 5xx -- cron-job.org ar putea reincerca imediat pe un 5xx, agravand exact
    // problema (Redis deja indisponibil).
    res.status(200).json({ ok: false, error: 'redis unavailable' });
    return;
  }
  if (!acquired) {
    // O rulare anterioara e inca activa (sau a picat fara sa elibereze lock-ul -- TTL-ul
    // il elibereaza oricum in max 110s) -- sarim, ca sa nu trimitem aceeasi alerta de doua ori.
    res.status(200).json({ ok: true, skipped: 'locked' });
    return;
  }

  try {
    const cfg = loadConfig();
    const store = {
      load: async () => {
        const saved = await getCheckerState();
        return { ...EMPTY_STATE(), ...(saved ?? {}) };
      },
      save: (state) => setCheckerState(state),
    };

    // Preferintele proprietarului (/setari) -- filtreaza ce apare in alertele/heartbeat-ul
    // trimise de checker, vezi runCheck. Un chat fara prefs salvate (niciodata n-a folosit
    // /setari) foloseste implicit "tot activat" (normalizePrefs(null)), comportamentul de
    // dinainte de /setari.
    const ownerPrefs = normalizePrefs(await getPrefs(cfg.telegram.chatId));

    const { messages, errors, allFailed, categoryResults } = await runCheck({
      config: cfg,
      store,
      fetchOptions: FETCH_OPTIONS,
      cache: new Map(),
      failureThreshold: FAILURE_THRESHOLD,
      prefs: ownerPrefs,
    });

    for (const msg of messages) {
      await sendTelegramMessage(cfg.telegram, msg.text, msg.keyboard);
    }

    res.status(200).json({
      ok: true,
      categoriesRead: categoryResults.length,
      errors: errors.length,
      allFailed,
      messagesSent: messages.length,
    });
  } catch (err) {
    console.error('Eroare in cron-check:', err);
    res.status(200).json({ ok: false, error: err.message });
  } finally {
    try {
      await releaseCheckerLock();
    } catch (err) {
      console.error('Eroare la eliberarea lock-ului checkerului:', err.message);
    }
  }
}
