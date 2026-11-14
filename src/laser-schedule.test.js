import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { estimateLaserHours, groupLaserSchedule, laserJobCounts, laserProgramStatus, parseLaserWorksheet, searchLaserMachines, validLaserSchedule } from './laser-schedule.js';

test('includes scrap and rework in CL progress, status and hour estimates', () => {
  const rows = [
    { machine: 'A', program: 'JOB', sequence: 1, hours: 3, ops: ['1'] },
    { machine: 'A', program: 'PARTIAL', sequence: 2, hours: 2, ops: ['2'] },
  ];
  const jobs = [
    ['JOB', [{ num: '1', steps: [
      { stageCode: 'CL', qtd: 15, reported: 14, reworkQty: 0, scrapQty: 1 },
      { stageCode: 'DB', qtd: 10, reported: 0, reworkQty: 4, scrapQty: 0 },
    ] }]],
    ['PARTIAL', [{ num: '2', steps: [
      { stageCode: 'CL', qtd: 10, reported: 3, reworkQty: 2, scrapQty: 1 },
    ] }]],
  ];
  const { machines } = groupLaserSchedule(rows, jobs);
  const [complete, partial] = machines[0].programs;
  assert.equal(complete.reported, 15);
  assert.equal(complete.planned, 15);
  assert.equal(laserProgramStatus(complete).label, 'Concluído');
  assert.equal(complete.clOps[0].steps[0].reported, 14);
  assert.equal(complete.clOps[0].steps[0].scrapQty, 1);
  assert.equal(partial.reported, 6);
  assert.equal(laserProgramStatus(partial).label, 'Corte Parcial');
  assert.deepEqual(laserJobCounts(machines[0].jobs), { complete: 1, partial: 1, progress: 0 });
  assert.deepEqual(estimateLaserHours([complete]), { total: 3, cut: 3, remaining: 0, unverified: 0 });
  assert.deepEqual(estimateLaserHours([partial]), { total: 2, cut: 1.2, remaining: 0.8, unverified: 0 });
});

test('searches CL jobs, operations and products across machines without changing totals', () => {
  const rows = [
    { machine: 'Fiber 4', program: 'PROG-A', sequence: 1, hours: 2, ops: ['00123'] },
    { machine: 'Fiber 6', program: 'PROG-B', sequence: 1, hours: 3, ops: ['123'] },
    { machine: 'Fiber 6', program: 'UNKNOWN', sequence: 2, hours: 4, ops: ['999'] },
    { machine: 'Yawei', program: 'OTHER', sequence: 1, hours: 5, ops: ['456'] },
  ];
  const jobs = [
    ['JOB-X', [
      { num: '123', desc: 'Peça especial', steps: [
        { stageCode: 'CL', qtd: 10, reported: 5, ord: 'ORD-CL', item: 'CL-ITEM' },
        { stageCode: 'DB', qtd: 10, reported: 0, ord: 'ORD-DB', item: 'DB-ONLY' },
      ] },
      { num: '789', desc: 'Outra peça', steps: [{ stageCode: 'CL', qtd: 1, reported: 0, ord: 'SECOND', item: 'OUTRO-ITEM' }] },
    ]],
    ['JOB-Y', [{ num: '456', desc: 'Produto Y', steps: [{ stageCode: 'CL', qtd: 2, reported: 0, item: 'ITEM-Y' }] }]],
  ];
  const { machines } = groupLaserSchedule(rows, jobs);
  for (const query of ['job-x', 'PROG-a', '00123', 'ord-cl', 'cl-item', 'peca especial', '789', 'outro-item']) {
    const result = searchLaserMachines(machines, query);
    assert.deepEqual(result.map((machine) => machine.machine), query === 'PROG-a' ? ['Fiber 4'] : ['Fiber 4', 'Fiber 6']);
    assert.ok(result.every((machine) => machine.programs.length === 1));
  }
  assert.deepEqual(searchLaserMachines(machines, 'DB-ONLY'), []);
  assert.deepEqual(searchLaserMachines(machines, 'ord-db'), []);
  const unmatched = searchLaserMachines(machines, '999');
  assert.equal(unmatched[0].programs[0].found, false);
  assert.deepEqual(searchLaserMachines(machines, 'sem resultado'), []);
  assert.equal(searchLaserMachines(machines, '  '), machines);
  assert.equal(machines.find((machine) => machine.machine === 'Fiber 6').programs.length, 2);
  assert.equal(machines.find((machine) => machine.machine === 'Fiber 6').hours, 3);
});

test('estimates remaining hours equally per CL OP and includes unmatched programs', () => {
  const rows = [
    { machine: 'A', program: 'JOB', sequence: 1, hours: 10, ops: ['1'] },
    { machine: 'A', program: 'MISSING', sequence: 2, hours: 3, ops: ['unknown'] },
    { machine: 'B', program: 'JOB', sequence: 1, hours: 4, ops: ['2'] },
  ];
  const jobs = [['JOB', [
    { num: '1', steps: [{ stageCode: 'CL', qtd: 10, reported: 10 }] },
    { num: '2', steps: [{ stageCode: 'CL', qtd: 20, reported: 10 }] },
  ]]];
  const { machines } = groupLaserSchedule(rows, jobs);
  assert.deepEqual(estimateLaserHours(machines[0].programs), {
    total: 13, cut: 7.5, remaining: 5.5, unverified: 3,
  });
  assert.deepEqual(estimateLaserHours(machines[1].programs), {
    total: 4, cut: 3, remaining: 1, unverified: 0,
  });
});

test('treats zero planned quantities as unverified and clamps over-reported quantities', () => {
  const programs = [
    { found: true, hours: 12, clOps: [
      { totalQty: 0, reportedQty: 1 },
      { totalQty: 10, reportedQty: 20 },
      { totalQty: 10, reportedQty: -3 },
    ] },
    { found: false, ambiguous: true, hours: 2 },
  ];
  assert.deepEqual(estimateLaserHours(programs), {
    total: 14, cut: 4, remaining: 10, unverified: 6,
  });
  assert.deepEqual(estimateLaserHours([]), { total: 0, cut: 0, remaining: 0, unverified: 0 });
});

test('labels partial CL progress without changing zero and complete statuses', () => {
  const cases = [
    [{ planned: 190, reported: 0, complete: false }, 'Em andamento'],
    [{ planned: 190, reported: 98, complete: false }, 'Corte Parcial'],
    [{ planned: 190, reported: 189, complete: false }, 'Corte Parcial'],
    [{ planned: 190, reported: 190, complete: true }, 'Concluído'],
    [{ planned: 190, reported: 200, complete: true }, 'Concluído'],
    [{ planned: 0, reported: 1, complete: false }, 'Em andamento'],
  ];
  for (const [program, expected] of cases) {
    assert.equal(laserProgramStatus(program).label, expected);
  }
});

test('parses a sequenciamento workbook and calculates matching CL load once per program', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sequenciamento laser');
  sheet.addRow(['Resumo']);
  sheet.addRow(['Máquina', 'Seq', 'Programa', 'Tempo (h)', 'OPs']);
  sheet.addRow(['Yawei X (trocada de Sem máquina)', 1, '0311K', 2.5, '00123, 124']);
  sheet.addRow(['Yawei X', 2, '0311L', 1.25, '125']);
  sheet.addRow(['Fiber 4', 1, 'OUTRO', 4, '999']);
  const buffer = await workbook.xlsx.writeBuffer();
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(buffer);
  const rows = parseLaserWorksheet(loaded.worksheets[0]);
  const result = groupLaserSchedule(rows, [
    ['0311K', ['123', '124'].map((num) => ({ num, steps: [{ stageCode: 'CL', qtd: 1, reported: 0 }] }))],
    ['0311L', [{ num: '125', steps: [{ stageCode: 'CL', qtd: 1, reported: 0 }] }]],
  ]);
  assert.equal(result.machines.length, 2);
  const machine = result.machines.find((entry) => entry.machine === 'Yawei X');
  assert.equal(machine.hours, 3.75);
  assert.equal(machine.programs.length, 2);
  assert.equal(machine.programs[0].found, true);
  const missingMachine = result.machines.find((entry) => entry.machine === 'Fiber 4');
  assert.equal(missingMachine.hours, 0);
  assert.equal(missingMachine.programs.length, 1);
  assert.equal(missingMachine.programs[0].found, false);
  assert.equal(missingMachine.programs[0].reported, null);
  assert.equal(missingMachine.programs[0].planned, null);
  assert.equal(result.unmatched, 1);
  const refreshed = groupLaserSchedule(rows, [
    ['OUTRO', [{ num: '999', steps: [{ stageCode: 'CL', qtd: 10, reported: 5 }] }]],
  ]);
  const recovered = refreshed.machines.find((entry) => entry.machine === 'Fiber 4');
  assert.equal(recovered.hours, 4);
  assert.equal(recovered.programs[0].reported, 5);
  assert.equal(recovered.programs[0].planned, 10);
  assert.equal(refreshed.unmatched, 2);
});

test('rejects malformed or incomplete schedule rows', () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Teste');
  sheet.addRow(['Máquina', 'Seq', 'Programa', 'Tempo (h)', 'OPs']);
  sheet.addRow(['Fiber 4', 1, '001', 'inválido', '123']);
  assert.throws(() => parseLaserWorksheet(sheet), /linha 2/);
  assert.equal(validLaserSchedule([{ machine: 'X', sequence: 1, program: 'A', hours: -1, ops: ['1'] }]), false);
  const missing = workbook.addWorksheet('Sem cabeçalho');
  missing.addRow(['Máquina']);
  assert.throws(() => parseLaserWorksheet(missing), /cabeçalhos/);
});

test('uses all CL stages of the production job for each associated program', () => {
  const rows = [
    { machine: 'A', program: 'P1', sequence: 1, hours: 2, ops: ['001', '1', '2'] },
    { machine: 'A', program: 'P2', sequence: 2, hours: 1, ops: ['1', '3'] },
    { machine: 'B', program: 'P3', sequence: 1, hours: 3, ops: ['2', '4'] },
  ];
  const jobs = [
    ['JOB1', [
      { num: '1', steps: [{ stageCode: 'CL', qtd: 10, reported: 15 }, { stageCode: 'DB', qtd: 100, reported: 0 }] },
      { num: '2', steps: [{ stageCode: 'CL', qtd: 10, reported: 5 }] },
      { num: '5', steps: [{ stageCode: 'CL', qtd: 20, reported: 10 }] },
    ]],
    ['JOB2', [{ num: '3', steps: [{ stageCode: 'CL', qtd: 10, reported: 4 }] }]],
    ['JOB3', [{ num: '4', steps: [{ stageCode: 'CL', qtd: 0, reported: 0 }] }]],
  ];
  const result = groupLaserSchedule(rows, jobs);
  const [firstProgram, secondProgram] = result.machines[0].programs;
  assert.deepEqual(
    { planned: firstProgram.planned, reported: firstProgram.reported, complete: firstProgram.complete },
    { planned: 40, reported: 30, complete: false },
  );
  assert.equal(secondProgram.found, false);
  assert.equal(secondProgram.ambiguous, true);
  assert.equal(result.machines[0].completedJobs, 0);
  assert.equal(result.machines[0].jobs.length, 1);
  assert.deepEqual(laserJobCounts(result.machines[0].jobs), { complete: 0, partial: 1, progress: 0 });
  assert.equal(result.machines[0].jobs[0].job, 'JOB1');
  assert.deepEqual(firstProgram.clOps.map(({ num, totalQty, reportedQty }) => ({ num, totalQty, reportedQty })), [
    { num: '1', totalQty: 10, reportedQty: 15 },
    { num: '2', totalQty: 10, reportedQty: 5 },
    { num: '5', totalQty: 20, reportedQty: 10 },
  ]);
  assert.deepEqual(firstProgram.clOps[0].steps.map((step) => step.stageCode), ['CL']);
  assert.equal(result.machines[1].programs[0].ambiguous, true);
  assert.deepEqual(result.machines[1].jobs, []);
});

test('matches program names to jobs and resolves complementary names from OPs', () => {
  const jobs = [['0710E', [
    { num: '271963', steps: [{ stageCode: 'CL', qtd: 10, reported: 0 }] },
    { num: 'other', steps: [{ stageCode: 'CL', qtd: 374, reported: 374 }] },
  ]]];
  const rows = [
    { machine: 'A', program: '0710e', sequence: 1, hours: 2, ops: ['missing'] },
    { machine: 'A', program: '0710E (OP COMPLEMENTAR)', sequence: 2, hours: 1, ops: ['271963', '271963'] },
    { machine: 'B', program: '0710E', sequence: 1, hours: 1, ops: ['271963'] },
    { machine: 'B', program: 'UNKNOWN', sequence: 2, hours: 1, ops: ['missing'] },
  ];
  const result = groupLaserSchedule(rows, jobs);
  for (const program of [result.machines[0].programs[0], result.machines[0].programs[1], result.machines[1].programs[0]]) {
    assert.equal(program.reported, 374);
    assert.equal(program.planned, 384);
    assert.equal((program.reported / program.planned * 100).toFixed(1), '97.4');
    assert.deepEqual(program.clOps.map((op) => op.num), ['271963', 'other']);
  }
  assert.equal(result.machines[0].jobs.length, 1);
  assert.equal(result.machines[1].programs[1].found, false);
  assert.equal(result.machines[1].hours, 1);
});

test('counts unique machine jobs by progress status', () => {
  const jobs = [
    { complete: true, planned: 10, reported: 10 },
    { complete: false, planned: 10, reported: 5 },
    { complete: false, planned: 10, reported: 0 },
    { complete: false, planned: 0, reported: 0 },
  ];
  assert.deepEqual(laserJobCounts(jobs), { complete: 1, partial: 1, progress: 2 });
  assert.deepEqual(laserJobCounts([]), { complete: 0, partial: 0, progress: 0 });
});
