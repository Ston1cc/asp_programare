// Teste pentru utilitarele din src/format.js -- data/fus orar si escaparea MarkdownV2
// (vezi CLAUDE.md, "De ce escaparea MarkdownV2 e centralizata").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysUntil,
  buildDateRanges,
  escapeMarkdownV2,
  getLocalDateString,
  filterWithinHorizon,
  buildPracticTable,
} from '../src/format.js';

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

test('filterWithinHorizon pastreaza zile din intreg orizontul de 90 de zile, nu doar luna curenta+urmatoarea', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const dates = [
    { date: '2026-09-22', timeSlots: 1 }, // ieri -- exclus
    { date: '2026-09-23', timeSlots: 2 }, // azi -- inclus
    { date: '2026-11-15', timeSlots: 3 }, // peste 2 luni -- vechiul filtru il pierdea
    { date: '2027-01-01', timeSlots: 4 }, // peste orizont -- exclus
  ];
  const kept = filterWithinHorizon(dates, now, 90).map((d) => d.date);
  assert.deepEqual(kept, ['2026-09-23', '2026-11-15']);
});

test('filterWithinHorizon respecta limita exacta a orizontului (inclusiv)', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const dates = [
    { date: '2026-01-31', timeSlots: 1 }, // exact +30 -- inclus
    { date: '2026-02-01', timeSlots: 1 }, // +31 -- exclus
  ];
  const kept = filterWithinHorizon(dates, now, 30).map((d) => d.date);
  assert.deepEqual(kept, ['2026-01-31']);
});

test('buildPracticTable taie la 25 de randuri si raporteaza cate au fost ascunse', () => {
  const dates = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    timeSlots: 1,
  }));
  const groups = [{ locationAbbr: 'A', display: { dates } }];
  const table = buildPracticTable(groups);
  assert.equal(table.text.split('\n').length, 1 + 25); // header + 25 randuri
  assert.equal(table.hiddenCount, 5);
  assert.equal(table.lastShownDate, '2026-10-25');
});

test('buildPracticTable nu taie nimic sub 25 de zile', () => {
  const dates = [{ date: '2026-10-01', timeSlots: 1 }, { date: '2026-10-02', timeSlots: 2 }];
  const table = buildPracticTable([{ locationAbbr: 'A', display: { dates } }]);
  assert.equal(table.hiddenCount, 0);
});
