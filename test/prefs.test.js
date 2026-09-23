// Teste pentru src/prefs.js -- filtrele /setari (ce APARE in mesaje, nu ce se citeste,
// vezi comentariul din check.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS,
  normalizePrefs,
  categoryMatchesPrefs,
  selectCategories,
  filterCategoryResultsByPrefs,
  applyPrefsToEvents,
  togglePref,
  parsePrefBeforeInput,
} from '../src/prefs.js';

test('normalizePrefs completeaza un record gol/corupt cu valorile implicite', () => {
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs({}), DEFAULT_PREFS);
  assert.deepEqual(normalizePrefs({ teoretic: false, ceva: 'strain' }), { ...DEFAULT_PREFS, teoretic: false });
});

test('normalizePrefs respinge un `before` cu format invalid, pastreaza unul valid', () => {
  assert.equal(normalizePrefs({ before: 'nu e o data' }).before, null);
  assert.equal(normalizePrefs({ before: '2026-10-15' }).before, '2026-10-15');
});

test('categoryMatchesPrefs: filtrul de locatie se aplica DOAR practicului, nu teoreticului', () => {
  const prefs = { ...DEFAULT_PREFS, locations: { radautanu: true, ieasilor: true, salcamilor: false } };
  const teoreticSalcamilor = { examType: 'teoretic', urgent: false, locationId: 'salcamilor' };
  const practicSalcamilor = { examType: 'practic', urgent: false, locationId: 'salcamilor' };
  assert.equal(categoryMatchesPrefs(teoreticSalcamilor, prefs), true); // teoretic nu e afectat
  assert.equal(categoryMatchesPrefs(practicSalcamilor, prefs), false); // practic e filtrat
});

test('categoryMatchesPrefs: obisnuit/urgent si teoretic/practic se filtreaza independent', () => {
  const onlyUrgent = { ...DEFAULT_PREFS, obisnuit: false };
  const cat = (examType, urgent) => ({ examType, urgent, locationId: 'salcamilor' });
  assert.equal(categoryMatchesPrefs(cat('teoretic', false), onlyUrgent), false);
  assert.equal(categoryMatchesPrefs(cat('teoretic', true), onlyUrgent), true);

  const onlyTeoretic = { ...DEFAULT_PREFS, practic: false };
  assert.equal(categoryMatchesPrefs(cat('practic', false), onlyTeoretic), false);
  assert.equal(categoryMatchesPrefs(cat('teoretic', false), onlyTeoretic), true);
});

test('selectCategories cu toate prefs implicite intoarce toate cele 8 categorii', () => {
  assert.equal(selectCategories(DEFAULT_PREFS).length, 8);
});

test('selectCategories cu practic dezactivat intoarce doar cele 2 teoretice', () => {
  const prefs = { ...DEFAULT_PREFS, practic: false };
  const result = selectCategories(prefs);
  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.examType === 'teoretic'));
});

test('filterCategoryResultsByPrefs filtreaza categoryResults dupa aceleasi reguli', () => {
  const results = [
    { category: { examType: 'teoretic', urgent: false, locationId: 'salcamilor' }, dates: [] },
    { category: { examType: 'practic', urgent: false, locationId: 'radautanu' }, dates: [] },
  ];
  const onlyTeoretic = { ...DEFAULT_PREFS, practic: false };
  const filtered = filterCategoryResultsByPrefs(onlyTeoretic, results);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].category.examType, 'teoretic');
});

test('applyPrefsToEvents elimina evenimentele de dupa data tinta (before)', () => {
  const prefs = { ...DEFAULT_PREFS, before: '2026-10-15' };
  const cat = { examType: 'teoretic', urgent: false, locationId: 'salcamilor' };
  const earlierDays = [
    { category: cat, newDate: '2026-10-10', prevDate: null },
    { category: cat, newDate: '2026-10-20', prevDate: null },
  ];
  const { earlierDays: filtered } = applyPrefsToEvents(prefs, { earlierDays, newLaterDays: [] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].newDate, '2026-10-10');
});

test('applyPrefsToEvents filtreaza si dupa categorie (teoretic/practic/obisnuit/urgent)', () => {
  const prefs = { ...DEFAULT_PREFS, urgent: false };
  const catObisnuit = { examType: 'teoretic', urgent: false, locationId: 'salcamilor' };
  const catUrgent = { examType: 'teoretic', urgent: true, locationId: 'salcamilor' };
  const newLaterDays = [
    { category: catObisnuit, date: '2026-10-10' },
    { category: catUrgent, date: '2026-10-10' },
  ];
  const { newLaterDays: filtered } = applyPrefsToEvents(prefs, { earlierDays: [], newLaterDays });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].category.urgent, false);
});

test('togglePref inverseaza un flag simplu fara sa modifice restul', () => {
  const next = togglePref(DEFAULT_PREFS, 'teoretic');
  assert.equal(next.teoretic, false);
  assert.equal(next.practic, DEFAULT_PREFS.practic);
  assert.equal(DEFAULT_PREFS.teoretic, true); // originalul ramane neschimbat (imutabil)
});

test('togglePref inverseaza o locatie prin "loc:<id>"', () => {
  const next = togglePref(DEFAULT_PREFS, 'loc:radautanu');
  assert.equal(next.locations.radautanu, false);
  assert.equal(next.locations.ieasilor, true);
});

test('togglePref pe un path necunoscut nu schimba nimic', () => {
  const next = togglePref(DEFAULT_PREFS, 'loc:nuexista');
  assert.deepEqual(next, DEFAULT_PREFS);
  const next2 = togglePref(DEFAULT_PREFS, 'ceva-strain');
  assert.deepEqual(next2, DEFAULT_PREFS);
});

test('parsePrefBeforeInput accepta DD.MM.YYYY si YYYY-MM-DD, respinge restul', () => {
  assert.deepEqual(parsePrefBeforeInput('15.10.2026'), { ok: true, before: '2026-10-15' });
  assert.deepEqual(parsePrefBeforeInput('2026-10-15'), { ok: true, before: '2026-10-15' });
  assert.equal(parsePrefBeforeInput('nu e o data').ok, false);
  assert.equal(parsePrefBeforeInput('31.02.2026').ok, false); // 31 februarie nu exista
});

test('parsePrefBeforeInput: "0" sau "sterge" curata tinta', () => {
  assert.deepEqual(parsePrefBeforeInput('0'), { ok: true, before: null });
  assert.deepEqual(parsePrefBeforeInput('șterge'), { ok: true, before: null });
});
