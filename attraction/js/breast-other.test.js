/* breast-other.test.js — the other-breast probe must be cleavage-relative,
 * never a hardcoded x-fraction, and must never return the nipple's own run.
 *
 * Bug: `runs.find(r => r[0] <= w*0.30 && w*0.30 <= r[1])` latched onto the
 * measured breast's own run on wide close-ups, reporting the measured
 * breast as "left_breast, truncated by frame edge".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { otherBreastRun } from './breast.js';

test('otherBreastRun ignores the nipple run on a wide close-up (the bug)', () => {
  const own = [50, 400]; // spans 0.30W=180 on a 600px frame
  const got = otherBreastRun([[20, 40], own], own, 350, 420);
  assert.equal(got, null); // [20,40] is <8px wide noise; own run excluded
});

test('otherBreastRun finds the mound left of the cleavage', () => {
  const own = [300, 520];
  const got = otherBreastRun([[20, 180], own], own, 400, 240);
  assert.deepEqual(got, [20, 180]);
});

test('otherBreastRun mirrors when the nipple is left of the cleavage', () => {
  const own = [80, 260];
  const got = otherBreastRun([own, [340, 500]], own, 150, 300);
  assert.deepEqual(got, [340, 500]);
});

test('otherBreastRun picks the run nearest the cleavage on its side', () => {
  const own = [300, 520];
  const got = otherBreastRun([[10, 60], [120, 200], own], own, 400, 240);
  assert.deepEqual(got, [120, 200]);
});
