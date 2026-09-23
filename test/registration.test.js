// Teste pentru fluxul conversational din src/registration.js -- validare IDNP (cu cifra
// de control), format data, si anularea pe orice raspuns care incepe cu "/" (vezi
// CLAUDE.md, problema semnalata la audit: nu trebuie tratat ca "IDNP invalid").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIdnp, parseIssueDate, advanceRegistration, startRegistrationPrompt } from '../src/registration.js';

// Checksum valid: ponderi 7/3/1 repetate pe primele 12 cifre, mod 10 == cifra 13.
const VALID_IDNP = '2000000000004';

test('validateIdnp accepta un IDNP cu cifra de control corecta', () => {
  assert.equal(validateIdnp(VALID_IDNP), VALID_IDNP);
});

test('validateIdnp respinge o cifra de control gresita', () => {
  const wrongChecksum = VALID_IDNP.slice(0, 12) + '9';
  assert.equal(validateIdnp(wrongChecksum), null);
});

test('validateIdnp respinge lungime gresita', () => {
  assert.equal(validateIdnp('123'), null);
  assert.equal(validateIdnp(VALID_IDNP + '5'), null);
});

test('parseIssueDate accepta atat ISO cat si formatul uman DD.MM.YYYY', () => {
  assert.equal(parseIssueDate('2020-01-15'), '2020-01-15T00:00:00');
  assert.equal(parseIssueDate('15.01.2020'), '2020-01-15T00:00:00');
});

test('parseIssueDate respinge date calendaristic invalide (ex: 31 februarie)', () => {
  assert.equal(parseIssueDate('31.02.2020'), null);
  assert.equal(parseIssueDate('nu e o data'), null);
});

test('advanceRegistration anuleaza cand userul scrie o comanda in loc de raspuns', () => {
  const { pending } = startRegistrationPrompt();
  const result = advanceRegistration(pending, '/acum');
  assert.equal(result.cancelled, true);
});

test('advanceRegistration parcurge cei 4 pasi pana la un person complet', () => {
  const { pending: p1 } = startRegistrationPrompt();

  const step1 = advanceRegistration(p1, VALID_IDNP);
  assert.equal(step1.pending.step, 'seria');

  const step2 = advanceRegistration(step1.pending, 'ab1234567');
  assert.equal(step2.pending.step, 'dataEliberarii');
  assert.equal(step2.pending.seria, 'AB1234567'); // normalizata uppercase, fara spatii

  const step3 = advanceRegistration(step2.pending, '01.01.2020');
  assert.equal(step3.pending.step, 'vehicle');
  assert.equal(step3.pending.issueDate, '2020-01-01T00:00:00');

  const step4 = advanceRegistration(step3.pending, '🔧 Manuală');
  assert.deepEqual(step4.person, {
    idnp: VALID_IDNP,
    seriaAndNumber: 'AB1234567',
    issueDate: '2020-01-01T00:00:00',
    vehicle: 'BMechanical',
  });
});

test('advanceRegistration accepta scurtaturi text pentru vehicul, nu doar butoanele', () => {
  const pending = { step: 'vehicle', idnp: VALID_IDNP, seria: 'AB1234567', issueDate: '2020-01-01T00:00:00' };
  assert.equal(advanceRegistration(pending, 'a').person.vehicle, 'BAutomatic');
  assert.equal(advanceRegistration(pending, 'automata').person.vehicle, 'BAutomatic');
  assert.equal(advanceRegistration(pending, 'm').person.vehicle, 'BMechanical');
  assert.equal(advanceRegistration(pending, 'mecanica').person.vehicle, 'BMechanical');
});

test('advanceRegistration re-prompteaza la pasul vehicle pe input neinteligibil', () => {
  const pending = { step: 'vehicle', idnp: VALID_IDNP, seria: 'AB1234567', issueDate: '2020-01-01T00:00:00' };
  const result = advanceRegistration(pending, 'nu stiu');
  assert.equal(result.pending.step, 'vehicle');
  assert.equal(result.person, undefined);
});

test('advanceRegistration re-prompteaza pe input invalid, fara sa avanseze pasul', () => {
  const { pending: p1 } = startRegistrationPrompt();
  const bad = advanceRegistration(p1, '123');
  assert.equal(bad.pending.step, 'idnp'); // ramane pe acelasi pas
  assert.match(bad.reply, /IDNP invalid/);
});
