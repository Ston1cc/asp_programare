// Teste pentru utilitarele din src/format.js -- data/fus orar si escaparea MarkdownV2
// (vezi CLAUDE.md, "De ce escaparea MarkdownV2 e centralizata").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, buildDateRanges, escapeMarkdownV2, getLocalDateString } from '../src/format.js';

test('daysUntil calculeaza diferenta corecta in zile calendaristice', () => {
  const now = new Date('2026-10-01T12:00:00Z'); // ~15:00 Europe/Chisinau (UTC+3 vara)
  assert.equal(daysUntil('2026-10-01', now), 0);
  assert.equal(daysUntil('2026-10-05', now), 4);
  assert.equal(daysUntil('2026-09-29', now), -2);
});

test('escapeMarkdownV2 escapeaza toate caracterele speciale MarkdownV2', () => {
  assert.equal(escapeMarkdownV2('DECA Chișinău (str. Salcâmilor, 28).'), 'DECA Chișinău \\(str\\. Salcâmilor, 28\\)\\.');
  assert.equal(escapeMarkdownV2('a_b*c[d]e'), 'a\\_b\\*c\\[d\\]e');
});

test('escapeMarkdownV2 e idempotent doar pe text simplu (nu pe markup deja aplicat)', () => {
  // Contract-ul din format.js: escapam FRAGMENTUL, apoi adaugam markup-ul -- niciodata invers.
  const escaped = escapeMarkdownV2('15 oct');
  const withMarkup = `*${escaped}*`;
  assert.equal(withMarkup, '*15 oct*');
});

test('buildDateRanges grupeaza zile consecutive cu acelasi numar de locuri', () => {
  const ranges = buildDateRanges([
    { date: '2026-10-15', timeSlots: 7 },
    { date: '2026-10-16', timeSlots: 7 },
    { date: '2026-10-17', timeSlots: 3 },
    { date: '2026-10-18', timeSlots: 3 },
    { date: '2026-10-19', timeSlots: 3 },
  ]);
  assert.deepEqual(ranges, [
    { start: '2026-10-15', end: '2026-10-16', timeSlots: 7 },
    { start: '2026-10-17', end: '2026-10-19', timeSlots: 3 },
  ]);
});

test('buildDateRanges sorteaza intrarile inainte de a grupa', () => {
  const ranges = buildDateRanges([
    { date: '2026-10-20', timeSlots: 1 },
    { date: '2026-10-15', timeSlots: 1 },
  ]);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].start, '2026-10-15');
  assert.equal(ranges[0].end, '2026-10-20');
});

test('getLocalDateString foloseste fusul Europe/Chisinau, nu UTC', () => {
  // 2026-10-01T22:30:00Z e deja 2026-10-02 in Chisinau (UTC+3).
  assert.equal(getLocalDateString(new Date('2026-10-01T22:30:00Z')), '2026-10-02');
});
