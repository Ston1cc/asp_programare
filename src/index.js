// Runner local pentru verificarea periodica. De la migrarea checkerului pe Vercel
// (api/cron-check.js, apelat de un cron extern la ~10 min -- vezi CLAUDE.md), acest
// fisier nu mai ruleaza automat prin GitHub Actions; ramane util pentru rulare manuala
// sau Task Scheduler (ex: daca ASP blocheaza IP-urile de datacenter ale Vercel, vezi
// README). State-ul e tot local (state/slots.json) si NU mai e comis in git -- doar
// checker-ul de pe Vercel (state in Redis) e sursa de adevar pentru alertele reale catre
// proprietar; rularea locala e complementara, nu duplicat.

import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadState, saveState } from './state.js';
import { runCheck } from './check.js';
import { sendTelegramMessage } from './telegram.js';

const STATE_PATH = fileURLToPath(new URL('../state/slots.json', import.meta.url));

async function main() {
  const config = loadConfig();
  const store = {
    load: () => loadState(STATE_PATH),
    save: (state) => saveState(STATE_PATH, state),
  };

  const { messages, errors, allFailed, categoryResults } = await runCheck({ config, store, failureThreshold: 3 });

  for (const msg of messages) {
    await sendTelegramMessage(config.telegram, msg);
  }

  console.log(
    `OK — ${categoryResults.length}/${categoryResults.length + errors.length} categorii citite, ${messages.length} mesaje trimise, ${errors.length} erori.`,
  );

  // Esec de proces doar daca TOATE categoriile au picat -- o categorie izolata nu trebuie
  // sa faca CI-ul rosu, dar o cadere totala merita vizibilitate.
  if (allFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Eroare fatala:', err);
  process.exitCode = 1;
});
