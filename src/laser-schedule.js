export const MAX_LASER_SCHEDULE_BYTES = 1024 * 1024;
const MAX_SCHEDULE_ROWS = 10_000;

const normalize = (value) => String(value).normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

export function laserProgramStatus(program) {
  if (program.complete) return { label: 'Concluído', className: 'laser-status-complete' };
  if (program.planned > 0 && program.reported > 0 && program.reported < program.planned) {
    return { label: 'Corte Parcial', className: 'laser-status-partial' };
  }
  return { label: 'Em andamento', className: 'laser-status-progress' };
}

export function laserJobCounts(jobs) {
  const counts = { complete: 0, partial: 0, progress: 0 };
  for (const job of jobs) {
    const status = laserProgramStatus(job).className;
    if (status === 'laser-status-complete') counts.complete += 1;
    else if (status === 'laser-status-partial') counts.partial += 1;
    else counts.progress += 1;
  }
  return counts;
}

export function estimateLaserHours(programs) {
  let total = 0;
  let cut = 0;
  let unverified = 0;
  for (const program of programs) {
    total += program.hours;
    if (!program.found) {
      unverified += program.hours;
      continue;
    }
    const hoursPerOp = program.hours / program.clOps.length;
    for (const op of program.clOps) {
      if (op.totalQty <= 0) {
        unverified += hoursPerOp;
        continue;
      }
      cut += hoursPerOp * Math.max(0, Math.min(op.reportedQty / op.totalQty, 1));
    }
  }
  return { total, cut, remaining: Math.max(0, total - cut), unverified };
}

export function normalizeOp(value) {
  const text = String(value).trim();
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : text.toUpperCase();
}

export function searchLaserMachines(machines, query) {
  const term = normalize(query);
  if (!term) return machines;
  const matches = (value) => normalize(value ?? '').includes(term);
  const matchesOp = (value) => matches(value)
    || (/^\d+$/.test(term) && /^\d+$/.test(String(value ?? '').trim())
      && normalizeOp(value) === normalizeOp(term));
  return machines.flatMap((machine) => {
    const programs = machine.programs.filter((program) =>
      matches(program.program) || matches(program.job)
      || program.ops.some(matchesOp)
      || (program.clOps || []).some((op) =>
        matchesOp(op.num) || matches(op.desc)
        || op.steps.some((step) => matchesOp(step.ord) || matches(step.item))),
    );
    return programs.length ? [{ ...machine, programs }] : [];
  });
}

export function validLaserSchedule(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_SCHEDULE_ROWS
    && rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)
      && typeof row.machine === 'string' && row.machine.trim().length > 0 && row.machine.length <= 200
      && typeof row.program === 'string' && row.program.trim().length > 0 && row.program.length <= 200
      && Number.isFinite(row.hours) && row.hours >= 0 && row.hours <= 100_000
      && Number.isSafeInteger(row.sequence) && row.sequence >= 0
      && Array.isArray(row.ops) && row.ops.length > 0 && row.ops.length <= 1000
      && row.ops.every((op) => typeof op === 'string' && op.trim().length > 0 && op.length <= 100));
}

export function parseLaserWorksheet(worksheet) {
  const required = ['maquina', 'seq', 'programa', 'tempo (h)', 'ops'];
  let columns;
  const rows = [];
  worksheet.eachRow((row, rowNumber) => {
    if (!columns) {
      const found = new Map();
      row.eachCell((cell, index) => found.set(normalize(cell.text), index));
      if (required.every((header) => found.has(header))) columns = found;
      return;
    }

    const machine = row.getCell(columns.get('maquina')).text.trim()
      .replace(/\s*\(trocada de .+\)\s*$/i, '').trim();
    const program = row.getCell(columns.get('programa')).text.trim();
    const hoursValue = row.getCell(columns.get('tempo (h)')).value;
    const sequenceValue = row.getCell(columns.get('seq')).value;
    const hours = typeof hoursValue === 'number' ? hoursValue : Number.NaN;
    const sequence = typeof sequenceValue === 'number' ? sequenceValue : Number.NaN;
    const ops = row.getCell(columns.get('ops')).text.split(/[,;\n]+/)
      .map((op) => op.trim()).filter(Boolean);
    if (!machine && !program && !ops.length) return;
    const entry = { machine, program, hours, sequence, ops };
    if (!validLaserSchedule([entry])) {
      throw new Error(`Dados inválidos na linha ${rowNumber} da planilha de sequenciamento.`);
    }
    rows.push(entry);
  });
  if (!columns) throw new Error('A planilha não contém os cabeçalhos Máquina, Seq, Programa, Tempo (h) e OPs.');
  if (!validLaserSchedule(rows)) throw new Error('A planilha está vazia ou excede o limite de 10.000 programas.');
  return rows;
}

export function groupLaserSchedule(rows, productionJobs) {
  const jobs = new Map();
  const jobsByOp = new Map();
  for (const [name, ops] of productionJobs) {
    const key = normalize(name);
    if (!key) continue;
    const clOps = ops.flatMap((op) => {
      const steps = op.steps.filter((step) => step.stageCode === 'CL');
      if (!steps.length) return [];
      return [{
        ...op,
        steps,
        totalQty: steps.reduce((total, step) => total + step.qtd, 0),
        reportedQty: steps.reduce((total, step) => total + step.reported, 0),
      }];
    });
    if (!clOps.length) continue;
    const planned = clOps.reduce((total, op) => total + op.totalQty, 0);
    const reported = clOps.reduce((total, op) => total + op.reportedQty, 0);
    jobs.set(key, { job: name, planned, reported, complete: planned > 0 && reported >= planned, clOps });
    for (const op of ops) {
      const opKey = normalizeOp(op.num ?? '');
      if (!opKey) continue;
      if (!jobsByOp.has(opKey)) jobsByOp.set(opKey, new Set());
      jobsByOp.get(opKey).add(key);
    }
  }
  const machines = new Map();
  let unmatched = 0;
  for (const row of rows) {
    if (!machines.has(row.machine)) {
      machines.set(row.machine, { machine: row.machine, hours: 0, programs: [], jobKeys: new Set() });
    }
    const machine = machines.get(row.machine);
    const exactJob = normalize(row.program);
    const associatedJobs = new Set(row.ops.flatMap((op) => [...(jobsByOp.get(normalizeOp(op)) || [])]));
    const jobKey = jobs.has(exactJob) ? exactJob : associatedJobs.size === 1 ? [...associatedJobs][0] : null;
    if (!jobKey) {
      unmatched += 1;
      machine.programs.push({
        ...row,
        found: false,
        ambiguous: associatedJobs.size > 1,
        planned: null,
        reported: null,
        complete: false,
      });
      continue;
    }
    machine.hours += row.hours;
    machine.jobKeys.add(jobKey);
    machine.programs.push({ ...row, ...jobs.get(jobKey), found: true, ambiguous: false });
  }
  return {
    machines: [...machines.values()].map(({ jobKeys, ...machine }) => {
      const machineJobs = [...jobKeys].map((key) => jobs.get(key));
      return { ...machine, jobs: machineJobs, completedJobs: machineJobs.filter((job) => job.complete).length };
    }).sort((a, b) => a.machine.localeCompare(b.machine, 'pt-BR')),
    unmatched,
  };
}
