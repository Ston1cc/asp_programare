// Teste pentru logica de diff din src/state.js -- computeDiff e nucleul "semnalului"
// pe care se bazeaza tot proiectul (vezi CLAUDE.md, sectiunea "Alert classification").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff } from '../src/state.js';

const EMPTY_STATE = () => ({
  lastRun: null,
  lastHeartbeatDate: null,
  consecutiveFailures: 0,
  earliest: {},
  slots: {},
  initialized: {},
});

const CAT = { key: 'teoretic-obisnuit', label: 'Teoretic obișnuit' };

test('prima citire a unei categorii e baseline silentios (fara evenimente)', () => {
  const state = EMPTY_STATE();
  const { earlierDays, newLaterDays, nextState } = computeDiff(state, [
    { category: CAT, dates: [{ date: '2026-10-10', timeSlots: 3 }] },
  ]);
  assert.deepEqual(earlierDays, []);
  assert.deepEqual(newLaterDays, []);
  assert.equal(nextState.earliest[CAT.key], '2026-10-10');
  assert.equal(nextState.initialized[CAT.key], true);
});

test('o zi mai devreme decat minimul cunoscut declanseaza earlierDays', () => {
  let state = EMPTY_STATE();
  ({ nextState: state } = computeDiff(state, [
    { category: CAT, dates: [{ date: '2026-10-10', timeSlots: 3 }] },
  ]));

  const { earlierDays, newLaterDays, nextState } = computeDiff(state, [
    { category: CAT, dates: [{ date: '2026-10-05', timeSlots: 2 }, { date: '2026-10-10', timeSlots: 3 }] },
  ]);
  assert.equal(earlierDays.length, 1);
  assert.equal(earlierDays[0].newDate, '2026-10-05');
  assert.equal(earlierDays[0].prevDate, '2026-10-10');
  assert.deepEqual(newLaterDays, []); // ziua care a stabilit recordul nu apare si aici
  assert.equal(nextState.earliest[CAT.key], '2026-10-05');
});

test('o zi noua, dar mai tarzie decat minimul, e newLaterDays, nu earlierDays', () => {
  let state = EMPTY_STATE();
  ({ nextState: state } = computeDiff(state, [
    { category: CAT, dates: [{ date: '2026-10-10', timeSlots: 3 }] },
  ]));

  const { earlierDays, newLaterDays, nextState } = computeDiff(state, [
    { category: CAT, dates: [{ date: '2026-10-10', timeSlots: 3 }, { date: '2026-10-20', timeSlots: 1 }] },
  ]);
  assert.deepEqual(earlierDays, []);
  assert.equal(newLaterDays.length, 1);
  assert.equal(newLaterDays[0].date, '2026-10-20');
  assert.equal(nextState.earliest[CAT.key], '2026-10-10'); // neschimbat
});

test('o zi disparuta nu genereaza alerta, doar dispare din earliest daca era minimul', () => {
  let state = EMPTY_STATE();
  ({ nextState: state } = computeDiff(state, [
    { category: CAT, dates: [{ date: '2026-10-10', timeSlots: 3 }] },
  ]));

  const { earlierDays, newLaterDays, nextState } = computeDiff(state, [
    { category: CAT, dates: [] },
  ]);
  assert.deepEqual(earlierDays, []);
  assert.deepEqual(newLaterDays, []);
  assert.equal(nextState.earliest[CAT.key], undefined);
});

test('categorie fara nicio zi libera nu seteaza earliest', () => {
  const state = EMPTY_STATE();
  const { nextState } = computeDiff(state, [{ category: CAT, dates: [] }]);
  assert.equal(nextState.earliest[CAT.key], undefined);
  assert.equal(nextState.initialized[CAT.key], true);
});
