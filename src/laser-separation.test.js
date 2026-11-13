import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { LASER_SEPARATION_OPTIONS, validSeparationUpdate } from './laser-separation.js';

test('migration preserves existing statuses and accepts exactly the supported values', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(await readFile(new URL('../migrations/0005_create_laser_separation.sql', import.meta.url), 'utf8'));
    const insert = db.prepare('INSERT INTO laser_separation (machine, program, status) VALUES (?, ?, ?)');
    insert.run('A', '1', 'paid');
    insert.run('A', '2', 'pending');
    db.exec(await readFile(new URL('../migrations/0006_expand_laser_separation.sql', import.meta.url), 'utf8'));
    assert.deepEqual(
      db.prepare('SELECT machine, program, status FROM laser_separation ORDER BY program').all().map((row) => ({ ...row })),
      [{ machine: 'A', program: '1', status: 'paid' }, { machine: 'A', program: '2', status: 'pending' }],
    );
    const save = db.prepare('INSERT INTO laser_separation (machine, program, status) VALUES (?, ?, ?)');
    for (const option of LASER_SEPARATION_OPTIONS) {
      assert.ok(validSeparationUpdate({ machine: 'B', program: option.value, status: option.value }));
      save.run('B', option.value, option.value);
    }
    assert.throws(() => save.run('B', 'invalid', 'invalid'), /CHECK constraint failed/);
    assert.equal(validSeparationUpdate({ machine: 'B', program: 'invalid', status: 'invalid' }), false);
  } finally {
    db.close();
  }
});
