import assert from 'node:assert/strict';
import test from 'node:test';
import { getField, projectDataset, projectViewDataset } from './dataset-projection.js';

test('resolves accented and duplicate normalized headers in their original order', () => {
  assert.equal(getField({ 'Nome Usuario': 'primeiro', 'Nome Usuário': 'segundo' }, 'Nome Usuário'), 'primeiro');
  assert.equal(getField({ 'Início Ordem': '08:00' }, 'Inicio Ordem'), '08:00');
  assert.equal(getField({ outro: 'valor' }, 'Nome Usuário'), '');
});

test('preserves displayed fields and emission dates while removing unused columns', () => {
  const rows = {
    ops: [{ 'Numero da OP': '1', 'Job de Corte': 'JOB', 'DT Emissão': '01/01/2026', Produto: 'ITEM', extra: 'large' }],
    ordens: [{ 'Ord Prod': '10', 'DT Emissão': '02/01/2026', 'Início Ordem': '03/01/2026', 'Quant Rep': '5', extra: 'large' }],
    apontamentos: [{ 'Ord Prod': '10', 'Desc Máquina': 'Laser', 'Nome Usuário': 'Operador', extra: 'large' }],
  };
  const result = projectDataset(rows);
  assert.equal(result.ops[0]['Numero da OP'], '1');
  assert.equal(getField(result.ops[0], 'DT Emissão'), '01/01/2026');
  assert.equal(getField(result.ordens[0], 'DT Emissão'), '02/01/2026');
  assert.equal(getField(result.ordens[0], 'Inicio Ordem'), '03/01/2026');
  assert.equal(getField(result.ordens[0], 'Quant Rep'), '5');
  assert.equal(getField(result.apontamentos[0], 'Desc Máquina'), 'Laser');
  for (const kind of ['ops', 'ordens']) assert.equal('extra' in result[kind][0], false);
  assert.equal(result.apontamentos[0].extra, 'large');
  assert.equal(rows.ops[0].extra, 'large');
});

test('preserves every report including repeated users, quantities and timestamps', () => {
  const apontamentos = [
    { 'Ord Prod': '1', 'Desc Máquina': 'A', 'Nome Usuário': 'B', Quantidade: '4', Horário: '08:00' },
    { 'Ord Prod': '1', 'Desc Máquina': 'A', 'Nome Usuário': 'B', Quantidade: '5', Horário: '09:00' },
    { 'Ord Prod': '1', 'Desc Máquina': 'A', 'Nome Usuário': 'C', Quantidade: '2', Horário: '10:00' },
    { 'Ord Prod': '1', 'Desc Máquina': 'A', 'Nome Usuário': 'C', Quantidade: '2', Horário: '10:00' },
  ];
  const result = projectDataset({
    ops: [], ordens: [],
    apontamentos,
  });
  assert.equal(result.apontamentos.length, 4);
  assert.deepEqual(result.apontamentos, apontamentos);
  assert.deepEqual([...new Set(result.apontamentos.map((row) => getField(row, 'Nome Usuário')))], ['B', 'C']);
  const view = projectViewDataset({ ...result, updatedAt: '2026-01-01' });
  assert.equal(view.apontamentos.length, 4);
  assert.deepEqual(view.apontamentos.map((row) => row['Nome Usuário']), ['B', 'B', 'C', 'C']);
  assert.ok(view.apontamentos.every((row) => !('Horário' in row) && !('Quantidade' in row)));
  assert.equal(view.updatedAt, '2026-01-01');
  assert.deepEqual(result.apontamentos, apontamentos);
});
