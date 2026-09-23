// Teste pentru src/check.js (runCheck) -- nucleul partajat de src/index.js (runner local)
// si api/cron-check.js (checkerul de pe Vercel). `fetchDates` e injectat ca sa nu loveasca
// ASP live si sa poata simula esecuri deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck } from '../src/check.js';
import { EMPTY_STATE } from '../src/state.js';
import { DEFAULT_PREFS } from '../src/prefs.js';

const CONFIG = { person: { idnp: '1', seriaAndNumber: 'AB1', issueDate: '2020-01-01T00:00:00' } };
const CATEGORIES = [
  { key: 'c1', label: 'Categoria 1', emoji: '📗', examType: 'teoretic', urgent: false, locationName: 'L1' },
];
const CATEGORIES_2 = [
  {
    key: 'c1',
    label: 'Teoretic',
    emoji: '📗',
    examType: 'teoretic',
    urgent: false,
    locationId: 'salcamilor',
    locationName: 'L1',
    locationShort: 'L1',
    locationAbbr: 'L1',
  },
  {
    key: 'c2',
    label: 'Practic',
    emoji: '🚦',
    examType: 'practic',
    urgent: false,
    locationId: 'radautanu',
    locationName: 'L2',
    locationShort: 'L2',
    locationAbbr: 'L2',
  },
];

function memoryStore(initial = EMPTY_STATE()) {
  let state = initial;
  return {
    load: async () => state,
    save: async (s) => {
      state = s;
    },
    get current() {
      return state;
    },
  };
}

test('runCheck: prima rulare (baseline) trimite mesajul de pornire, nu o alerta', async () => {
  const now = new Date('2026-09-23T02:00:00Z'); // 05:00 Chisinau (UTC+3 vara) -- inainte de heartbeat (7:30)
  const store = memoryStore();
  const fetchDates = async () => [{ date: '2026-09-25', timeSlots: 3 }];

  const { messages, errors, allFailed, categoryResults } = await runCheck({
    config: CONFIG,
    store,
    now,
    categories: CATEGORIES,
    fetchDates,
  });

  assert.equal(errors.length, 0);
  assert.equal(allFailed, false);
  assert.equal(categoryResults.length, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Monitor pornit/);
  assert.equal(store.current.initialized.c1, true);
  assert.equal(store.current.earliest.c1, '2026-09-25');
});

test('runCheck: o zi mai devreme la a doua rulare produce alerta 🔥', async () => {
  const store = memoryStore();
  await runCheck({
    config: CONFIG,
    store,
    now: new Date('2026-09-23T02:00:00Z'), // 05:00 Chisinau -- inainte de heartbeat
    categories: CATEGORIES,
    fetchDates: async () => [{ date: '2026-09-25', timeSlots: 3 }],
  });

  const { messages } = await runCheck({
    config: CONFIG,
    store,
    now: new Date('2026-09-23T03:00:00Z'), // 06:00 Chisinau -- tot inainte de heartbeat
    categories: CATEGORIES,
    fetchDates: async () => [{ date: '2026-09-24', timeSlots: 1 }],
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /devreme/);
  assert.equal(messages[0].keyboard.inline_keyboard[0][0].text, '📝 Programează-te');
});

test('runCheck: dupa ora heartbeat-ului trimite rezumatul zilnic o singura data pe zi', async () => {
  const store = memoryStore();
  await runCheck({
    config: CONFIG,
    store,
    now: new Date('2026-09-23T02:00:00Z'), // 05:00 Chisinau -- inainte de heartbeat
    categories: CATEGORIES,
    fetchDates: async () => [{ date: '2026-09-25', timeSlots: 3 }],
  });

  const afterHeartbeat = new Date('2026-09-23T05:00:00Z'); // 08:00 Chisinau -- dupa 7:30
  const first = await runCheck({
    config: CONFIG,
    store,
    now: afterHeartbeat,
    categories: CATEGORIES,
    fetchDates: async () => [{ date: '2026-09-25', timeSlots: 3 }],
  });
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].text, /Situație/);
  assert.equal(first.messages[0].keyboard, undefined); // heartbeat-ul nu are butonul de programare

  const second = await runCheck({
    config: CONFIG,
    store,
    now: new Date(afterHeartbeat.getTime() + 60_000),
    categories: CATEGORIES,
    fetchDates: async () => [{ date: '2026-09-25', timeSlots: 3 }],
  });
  assert.equal(second.messages.length, 0); // heartbeat deja trimis azi
});

test('runCheck: alerta de esec apare exact cand streak-ul atinge failureThreshold', async () => {
  const store = memoryStore();
  const failing = async () => {
    throw new Error('ASP jos');
  };

  const r1 = await runCheck({ config: CONFIG, store, categories: CATEGORIES, fetchDates: failing, failureThreshold: 2 });
  assert.equal(r1.allFailed, true);
  assert.equal(r1.messages.length, 0); // 1/2

  const r2 = await runCheck({ config: CONFIG, store, categories: CATEGORIES, fetchDates: failing, failureThreshold: 2 });
  assert.equal(r2.messages.length, 1); // 2/2 -- acum trimite
  assert.match(r2.messages[0].text, /nu poate citi calendarul/);

  const r3 = await runCheck({ config: CONFIG, store, categories: CATEGORIES, fetchDates: failing, failureThreshold: 2 });
  assert.equal(r3.messages.length, 0); // nu retrimite la fiecare rulare ulterioara
});

test('runCheck: un succes reseteaza streak-ul de esecuri la 0', async () => {
  const store = memoryStore();
  const failing = async () => {
    throw new Error('ASP jos');
  };
  await runCheck({ config: CONFIG, store, categories: CATEGORIES, fetchDates: failing, failureThreshold: 5 });
  assert.equal(store.current.consecutiveFailures, 1);

  await runCheck({ config: CONFIG, store, categories: CATEGORIES, fetchDates: async () => [] });
  assert.equal(store.current.consecutiveFailures, 0);
});

test('runCheck: prefs filtreaza ce APARE in alerta, dar tot citeste + diff-uieste categoriile ascunse', async () => {
  const store = memoryStore();
  const fetchByKey = (cat) => (cat.key === 'c1' ? [{ date: '2026-10-10', timeSlots: 3 }] : [{ date: '2026-10-10', timeSlots: 5 }]);

  // Baseline -- inainte de heartbeat, ambele categorii.
  await runCheck({
    config: CONFIG,
    store,
    now: new Date('2026-09-23T02:00:00Z'),
    categories: CATEGORIES_2,
    fetchDates: async (cat) => fetchByKey(cat),
  });

  // A doua rulare: ambele categorii primesc o zi mai devreme, dar prefs dezactiveaza practic.
  const prefs = { ...DEFAULT_PREFS, practic: false };
  const { messages, categoryResults } = await runCheck({
    config: CONFIG,
    store,
    now: new Date('2026-09-23T03:00:00Z'),
    categories: CATEGORIES_2,
    fetchDates: async (cat) => (cat.key === 'c1' ? [{ date: '2026-10-05', timeSlots: 1 }] : [{ date: '2026-10-05', timeSlots: 1 }]),
    prefs,
  });

  assert.equal(categoryResults.length, 2); // ambele au fost citite
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Teoretic/);
  assert.doesNotMatch(messages[0].text, /Practic/);
  assert.equal(store.current.earliest.c2, '2026-10-05'); // diff-uit + salvat, desi ascuns din mesaj
});
