import assert from 'node:assert/strict';
import test from 'node:test';
import { totalReported } from './production-progress.js';

test('adds reported, rework and scrap quantities without modifying their values', () => {
  for (const [step, expected] of [
    [{ reported: 14, reworkQty: 0, scrapQty: 1 }, 15],
    [{ reported: 10, reworkQty: 2, scrapQty: 3 }, 15],
    [{ reported: 0, reworkQty: 1, scrapQty: 0 }, 1],
    [{ reported: 0, reworkQty: 0, scrapQty: 1 }, 1],
    [{ reported: 7 }, 7],
  ]) {
    assert.equal(totalReported(step), expected);
  }
});
