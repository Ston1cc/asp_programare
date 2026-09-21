// Orchestrator pentru comenzi Telegram la cerere (ex: "/acum") -- verifica daca a venit
// un mesaj nou de la userul configurat si, daca e o comanda cunoscuta, face o interogare
// LIVE (nu din state/cache) si raspunde imediat. Ruleaza separat de index.js (job de
// verificare periodica), la interval mult mai scurt, ca raspunsul sa vina rapid.

import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CATEGORIES, loadConfig } from './config.js';
import { fetchCategoryDates } from './asp.js';
import { filterCurrentAndNextMonth, buildLiveNowMessage, escapeMarkdownV2 } from './format.js';
import { sendTelegramMessage, getTelegramUpdates } from './telegram.js';

const TELEGRAM_STATE_PATH = fileURLToPath(new URL('../state/telegram.json', import.meta.url));

// Orice varianta scurta, fara sa fim pretentiosi cu userul care scrie de pe telefon.
const TRIGGER_COMMANDS = new Set(['/acum', '/live', '/status', '/check']);

async function loadTelegramState() {
  try {
    const raw = await readFile(TELEGRAM_STATE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { lastUpdateId: null };
    throw err;
  }
}

async function saveTelegramState(state) {
  await mkdir(dirname(TELEGRAM_STATE_PATH), { recursive: true });
  await writeFile(TELEGRAM_STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

async function main() {
  const config = loadConfig();
  const state = await loadTelegramState();

  const offset = state.lastUpdateId != null ? state.lastUpdateId + 1 : undefined;
  const updates = await getTelegramUpdates(config.telegram, offset);

  if (updates.length === 0) {
    console.log('Fara mesaje noi.');
    return;
  }

  // Doar mesaje din chatul configurat -- ignoram orice altcineva ar scrie botului.
  const ownMessages = updates.filter(
    (u) => u.message && String(u.message.chat.id) === String(config.telegram.chatId),
  );
  const commandTexts = ownMessages
    .map((u) => (u.message.text ?? '').trim().toLowerCase())
    .filter((text) => TRIGGER_COMMANDS.has(text));

  // Marcam TOATE update-urile ca procesate (comanda sau nu), ca sa nu le tot recitim.
  const maxUpdateId = Math.max(...updates.map((u) => u.update_id));

  if (commandTexts.length === 0) {
    console.log(`${updates.length} update-uri noi, niciuna nu e comanda cunoscuta.`);
    await saveTelegramState({ lastUpdateId: maxUpdateId });
    return;
  }

  // Daca a venit de mai multe ori "/acum" intre doua rulari, raspundem o singura data.
  console.log(`Comanda live primita (${commandTexts.length}x) -- interoghez ASP live...`);

  const categoryResults = [];
  const errors = [];
  const now = new Date();

  for (const category of CATEGORIES) {
    try {
      const dates = await fetchCategoryDates(category, config.person);
      categoryResults.push({ category, dates: filterCurrentAndNextMonth(dates, now) });
    } catch (err) {
      console.error(`[${category.key}] esuat: ${err.message}`);
      errors.push([category.label, err.message]);
    }
  }

  let message = buildLiveNowMessage({ categoryResults, now });
  if (errors.length > 0) {
    message += `\n\n⚠️ ${escapeMarkdownV2(`${errors.length}/${CATEGORIES.length} categorii n-au putut fi citite acum.`)}`;
  }

  await sendTelegramMessage(config.telegram, message);
  await saveTelegramState({ lastUpdateId: maxUpdateId });

  console.log(`Raspuns live trimis (${categoryResults.length}/${CATEGORIES.length} categorii citite).`);
}

main().catch((err) => {
  console.error('Eroare fatala:', err);
  process.exitCode = 1;
});
