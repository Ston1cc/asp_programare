// Inregistreaza comenzile in meniul nativ Telegram (butonul "Menu" de langa campul de
// text) -- apel unic, de rulat doar cand se schimba lista de comenzi, nu la fiecare
// deploy. Doua liste: una default (toata lumea, inclusiv straini care abia scriu botului
// prima data) si una restransa doar pentru proprietar (scope `chat`) -- proprietarul n-are
// ce face cu /inregistrare sau /sterge, datele lui vin din .env, nu din Redis.
//
// Rulare: node --env-file=.env scripts/set-commands.mjs

import { loadConfig } from '../src/config.js';
import { setMyCommands } from '../src/telegram.js';

const cfg = loadConfig();

const ALL_COMMANDS = [
  { command: 'acum', description: 'Verifică live cele mai apropiate date la examen' },
  { command: 'setari', description: 'Alege ce categorii/dată-țintă apar la /acum' },
  { command: 'inregistrare', description: 'Introdu IDNP/serie/dată ca să folosești botul în numele tău' },
  { command: 'sterge', description: 'Șterge datele tale salvate' },
  { command: 'help', description: 'Lista comenzilor disponibile' },
];

const OWNER_COMMANDS = [
  { command: 'acum', description: 'Verifică live cele mai apropiate date la examen' },
  { command: 'setari', description: 'Alege ce categorii/dată-țintă primesc alerte' },
  { command: 'utilizatori', description: 'Listează persoanele cu acces aprobat' },
  { command: 'revoca', description: 'Revocă accesul unei persoane (revoca <chat_id>)' },
  { command: 'help', description: 'Lista comenzilor disponibile' },
];

await setMyCommands(cfg.telegram.botToken, ALL_COMMANDS);
console.log('Setate comenzile default (toata lumea):', ALL_COMMANDS.map((c) => c.command).join(', '));

await setMyCommands(cfg.telegram.botToken, OWNER_COMMANDS, { type: 'chat', chat_id: cfg.telegram.chatId });
console.log('Setate comenzile pentru proprietar (chat', cfg.telegram.chatId, '):', OWNER_COMMANDS.map((c) => c.command).join(', '));
