// Teste pentru src/config.js -- buildCategories(vehicle), in special ca cheile categoriilor
// practice sa nu se suprapuna intre BMechanical si BAutomatic (ar amesteca starea a doi
// useri care aleg vehicule diferite, vezi CLAUDE.md / computeDiff).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCategories, CATEGORIES, DEFAULT_VEHICLE } from '../src/config.js';

test('buildCategories() fara argument e identic cu CATEGORIES (comportamentul implicit)', () => {
  const mechanical = buildCategories();
  assert.deepEqual(mechanical, CATEGORIES);
  assert.equal(DEFAULT_VEHICLE, 'BMechanical');
});

test('buildCategories(BAutomatic) foloseste cheile practice cu sufix -auto, distincte de BMechanical', () => {
  const mechanical = buildCategories('BMechanical');
  const automatic = buildCategories('BAutomatic');

  const mechKeys = new Set(mechanical.filter((c) => c.examType === 'practic').map((c) => c.key));
  const autoKeys = new Set(automatic.filter((c) => c.examType === 'practic').map((c) => c.key));

  for (const key of autoKeys) assert.equal(mechKeys.has(key), false, `cheia ${key} se suprapune intre vehicule`);
});

test('buildCategories(BAutomatic) nu schimba cheile teoretice (n-au segment de vehicul)', () => {
  const mechanical = buildCategories('BMechanical');
  const automatic = buildCategories('BAutomatic');
  const teoreticKeys = (list) => list.filter((c) => c.examType === 'teoretic').map((c) => c.key);
  assert.deepEqual(teoreticKeys(mechanical), teoreticKeys(automatic));
});

test('buildCategories(BAutomatic) construieste servicePath cu segmentul de vehicul corect', () => {
  const automatic = buildCategories('BAutomatic');
  const practic = automatic.find((c) => c.examType === 'practic' && !c.urgent);
  assert.match(practic.servicePath, /\/BAutomatic$/);
});

test('buildCategories produce acelasi numar de categorii indiferent de vehicul (3 filiale x 2 tipuri practic + 2 teoretic)', () => {
  assert.equal(buildCategories('BMechanical').length, 8);
  assert.equal(buildCategories('BAutomatic').length, 8);
});
