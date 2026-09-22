// workbench/resume-util.test.js — plain-node tests for the crash-resume helpers.
// Run: node resume-util.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingInstruments, orderReportHtml, describeResume, sanitizeFaces, INSTRUMENT_KEYS,
} from './resume-util.js';

test('remainingInstruments returns selected-but-unfinished, in run order', () => {
  assert.deepEqual(
    remainingInstruments({ age: true, tele: true, body: true, bust: true }, ['age', 'tele']),
    ['body', 'bust']
  );
  assert.deepEqual(
    remainingInstruments({ age: true, tele: false, body: true, bust: false }, []),
    ['age', 'body']
  );
  assert.deepEqual(
    remainingInstruments({ age: true, tele: true, body: true, bust: true }, ['age', 'tele', 'body', 'bust']),
    []
  );
  // unselected instruments are never "remaining"
  assert.deepEqual(
    remainingInstruments({ age: false, tele: false, body: true, bust: false }, []),
    ['body']
  );
});

test('orderReportHtml rebuilds the report in completion order, tolerates gaps', () => {
  assert.equal(
    orderReportHtml(['age', 'tele', 'body'], { age: '<a>', tele: '<b>', body: '<c>' }),
    '<a><b><c>'
  );
  assert.equal(orderReportHtml(['age', 'tele'], { age: '<a>' }), '<a>', 'missing card renders empty');
  assert.equal(orderReportHtml([], {}), '');
});

test('describeResume names the photo, completed and remaining instruments', () => {
  const rec = {
    startedAt: 1727400000000, photoName: 'dan-photo.jpg',
    instruments: { age: true, tele: true, body: true, bust: true },
    done: ['age', 'tele'],
  };
  const s = describeResume(rec);
  assert.ok(s.includes('dan-photo.jpg'), 'photo name: ' + s);
  assert.ok(s.includes('age') && s.includes('telemetry'), 'completed: ' + s);
  assert.ok(s.includes('body') && s.includes('breast'), 'remaining: ' + s);
});

test('sanitizeFaces strips everything but bbox/score/kps', () => {
  const faces = [{ bbox: [1, 2, 3, 4], score: 0.9, kps: [[1, 2]], crop: 'huge-data-url', extra: 1 }];
  assert.deepEqual(sanitizeFaces(faces), [{ bbox: [1, 2, 3, 4], score: 0.9, kps: [[1, 2]] }]);
  assert.deepEqual(sanitizeFaces(null), []);
});

test('RESUME SIMULATION: persisted record rebuilds report and drives only the remainder', () => {
  // What persist() writes after age+tele finished, before the tab died:
  const rec = {
    instruments: { age: true, tele: true, body: true, bust: true },
    done: ['age', 'tele'],
    order: ['age', 'tele'],
    html: { age: '<div id=c-age>age card</div>', tele: '<div id=c-tele>tele card</div>' },
  };
  // What resume does on the next page load:
  const restoredHtml = orderReportHtml(rec.order, rec.html);
  assert.ok(restoredHtml.includes('c-age') && restoredHtml.includes('c-tele'));
  const remaining = remainingInstruments(rec.instruments, rec.done);
  assert.deepEqual(remaining, ['body', 'bust']);
  // The resumed run appends in run order:
  const finalOrder = [...rec.order, ...remaining];
  assert.deepEqual(finalOrder, ['age', 'tele', 'body', 'bust']);
  assert.deepEqual(INSTRUMENT_KEYS, ['age', 'tele', 'body', 'bust']);
});
