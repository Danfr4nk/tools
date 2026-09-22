// workbench/model-lifecycle.test.js — plain-node tests for the lazy/dispose/resume planner.
// Run: node model-lifecycle.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planLifecycle, createModelManager, runPlannedSteps, MODEL_DEFS, RUN_ORDER,
} from './model-lifecycle.js';

const loadsOf = plan => plan.steps.flatMap(s => s.load);
const releasesOf = plan => plan.steps.flatMap(s => s.release);

test('full selection: detect on, exact load/release sequence, one model at a time', () => {
  const plan = planLifecycle({ age: true, tele: true, body: true, bust: true });
  assert.equal(plan.detect, true);
  assert.deepEqual(plan.steps.map(s => s.instrument), ['age', 'tele', 'body', 'bust']);
  assert.deepEqual(plan.steps[0], { instrument: 'age', load: ['ga', 'vit'], release: ['ga', 'vit'] });
  assert.deepEqual(plan.steps[1], { instrument: 'tele', load: ['land'], release: [] });
  assert.deepEqual(plan.steps[2], { instrument: 'body', load: ['pose'], release: ['land'] });
  assert.deepEqual(plan.steps[3], { instrument: 'bust', load: ['pose'], release: ['pose'] });
});

test('body-only: no detection model, no landmarks, pose only', () => {
  const plan = planLifecycle({ age: false, tele: false, body: true, bust: false });
  assert.equal(plan.detect, false);
  assert.deepEqual(plan.steps, [{ instrument: 'body', load: ['pose'], release: ['pose'] }]);
});

test('age-only: detection + ga + vit, everything released', () => {
  const plan = planLifecycle({ age: true, tele: false, body: false, bust: false });
  assert.equal(plan.detect, true);
  assert.deepEqual(plan.steps, [{ instrument: 'age', load: ['ga', 'vit'], release: ['ga', 'vit'] }]);
});

test('telemetry-only: landmarker loads and releases in its own step', () => {
  const plan = planLifecycle({ age: false, tele: true, body: false, bust: false });
  assert.equal(plan.detect, true);
  assert.deepEqual(plan.steps, [{ instrument: 'tele', load: ['land'], release: ['land'] }]);
});

test('bust-only: detection for faces, pose for the cross-check', () => {
  const plan = planLifecycle({ age: false, tele: false, body: false, bust: true });
  assert.equal(plan.detect, true);
  assert.deepEqual(plan.steps, [{ instrument: 'bust', load: ['pose'], release: ['pose'] }]);
});

test('tele+body: landmarker survives telemetry for the body anchor, releases after body', () => {
  const plan = planLifecycle({ age: false, tele: true, body: true, bust: false });
  assert.equal(plan.detect, true);
  assert.deepEqual(plan.steps[0], { instrument: 'tele', load: ['land'], release: [] });
  assert.deepEqual(plan.steps[1], { instrument: 'body', load: ['pose'], release: ['land', 'pose'] });
});

test('nothing selected: no detection, no steps', () => {
  const plan = planLifecycle({ age: false, tele: false, body: false, bust: false });
  assert.equal(plan.detect, false);
  assert.deepEqual(plan.steps, []);
});

test('ArcFace (rec) appears in no plan, for any of the 16 selections', () => {
  for (let mask = 0; mask < 16; mask++) {
    const sel = { age: !!(mask & 1), tele: !!(mask & 2), body: !!(mask & 4), bust: !!(mask & 8) };
    const plan = planLifecycle(sel);
    for (const s of plan.steps) {
      assert.ok(!s.load.includes('rec'), 'rec loaded for ' + JSON.stringify(sel));
      assert.ok(!s.release.includes('rec'), 'rec released for ' + JSON.stringify(sel));
    }
  }
});

test('every loaded model is released by the end of its plan (all 16 selections)', () => {
  for (let mask = 0; mask < 16; mask++) {
    const sel = { age: !!(mask & 1), tele: !!(mask & 2), body: !!(mask & 4), bust: !!(mask & 8) };
    const plan = planLifecycle(sel);
    // unique sets: a re-ensure of an already-resident model is a no-op,
    // so it must not demand a second release
    const loads = [...new Set(loadsOf(plan))].sort();
    const releases = [...new Set(releasesOf(plan))].sort();
    assert.deepEqual(loads, releases,
      'load/release mismatch for ' + JSON.stringify(sel));
    // the release of each model comes at or after its last load step
    const stepIdx = {};
    plan.steps.forEach((s, i) => {
      for (const m of s.load) stepIdx[m + ':load'] = i;
      for (const m of s.release) stepIdx[m + ':rel'] = i;
    });
    for (const m of loads)
      assert.ok(stepIdx[m + ':rel'] >= stepIdx[m + ':load'], m + ' released before its last load');
  }
});

// ---- manager ----

function mockDeps(events) {
  const handles = {};
  return {
    handles,
    load: async key => {
      events.push('load:' + key);
      const h = { key, closed: false };
      handles[key] = h;
      return h;
    },
    dispose: async (key, h) => {
      events.push('dispose:' + key);
      assert.strictEqual(h, handles[key], 'dispose must receive the exact handle load returned');
      h.closed = true;
    },
    onStatus: (key, state, pct) => events.push('status:' + key + ':' + state),
  };
}

test('manager: full run disposes everything, exact event order, nothing lingers', async () => {
  const events = [];
  const mgr = createModelManager(mockDeps(events));
  const done = new Set();
  const plan = planLifecycle({ age: true, tele: true, body: true, bust: true });
  const ran = [];
  await runPlannedSteps(plan, done, {
    ensure: m => mgr.ensure(m),
    release: m => mgr.release(m),
    runInstrument: async inst => { ran.push(inst); },
  });
  assert.deepEqual(ran, ['age', 'tele', 'body', 'bust']);
  assert.deepEqual([...done], ['age', 'tele', 'body', 'bust']);
  const core = events.filter(e => e.startsWith('load:') || e.startsWith('dispose:'));
  assert.deepEqual(core, [
    'load:ga', 'load:vit', 'dispose:ga', 'dispose:vit',
    'load:land',
    'load:pose', 'dispose:land',
    'dispose:pose',
  ]);
  for (const [key] of MODEL_DEFS)
    assert.equal(mgr.isLoaded(key), false, key + ' still referenced after release');
  assert.ok(!core.some(e => e.includes('rec')), 'ArcFace must never load');
});

test('manager: peak residency never exceeds two models (land+pose overlap only)', async () => {
  const events = [];
  const mgr = createModelManager(mockDeps(events));
  let resident = 0, peak = 0;
  const residentKeys = new Set();
  await runPlannedSteps(planLifecycle({ age: true, tele: true, body: true, bust: true }), new Set(), {
    ensure: async m => { const h = await mgr.ensure(m); resident++; residentKeys.add(m); peak = Math.max(peak, resident); return h; },
    release: async m => { await mgr.release(m); resident--; residentKeys.delete(m); },
    runInstrument: async inst => {
      if (inst === 'body') assert.deepEqual([...residentKeys].sort(), ['land', 'pose']);
    },
  });
  assert.ok(peak <= 2, 'peak residency ' + peak + ' exceeds 2');
});

test('manager: ensure after release reloads (no stale handle)', async () => {
  const events = [];
  const mgr = createModelManager(mockDeps(events));
  const h1 = await mgr.ensure('ga');
  await mgr.release('ga');
  assert.equal(mgr.isLoaded('ga'), false);
  const h2 = await mgr.ensure('ga');
  assert.notStrictEqual(h2, h1, 'must not reuse the disposed handle');
  assert.deepEqual(events.filter(e => e === 'load:ga').length, 2);
  await mgr.release('ga');
});

test('manager: release of a never-loaded model is a safe no-op', async () => {
  const events = [];
  const mgr = createModelManager(mockDeps(events));
  await mgr.release('vit'); // must not throw, must not call dispose
  assert.ok(!events.some(e => e.startsWith('dispose:')));
  assert.equal(mgr.state('vit'), 'released');
});

test('manager: load failure resets to idle and does not linger', async () => {
  const mgr = createModelManager({
    load: async () => { throw new Error('boom'); },
    dispose: async () => { throw new Error('should not be called'); },
    onStatus: () => {},
  });
  await assert.rejects(() => mgr.ensure('ga'), /boom/);
  assert.equal(mgr.isLoaded('ga'), false);
  assert.equal(mgr.state('ga'), 'idle');
});

test('runPlannedSteps: skips done instruments (resume)', async () => {
  const mgr = createModelManager(mockDeps([]));
  const done = new Set(['age', 'tele']);
  const ran = [];
  await runPlannedSteps(planLifecycle({ age: true, tele: true, body: true, bust: true }), done, {
    ensure: m => mgr.ensure(m),
    release: m => mgr.release(m),
    runInstrument: async inst => { ran.push(inst); },
  });
  assert.deepEqual(ran, ['body', 'bust']);
  assert.deepEqual([...done].sort(), ['age', 'body', 'bust', 'tele']);
});

test('runPlannedSteps: a throwing instrument is not marked done, but its models release', async () => {
  const events = [];
  const mgr = createModelManager(mockDeps(events));
  const done = new Set();
  const boom = new Error('instrument exploded');
  await assert.rejects(
    runPlannedSteps(planLifecycle({ age: true, tele: false, body: false, bust: false }), done, {
      ensure: m => mgr.ensure(m),
      release: m => mgr.release(m),
      runInstrument: async () => { throw boom; },
    }),
    /instrument exploded/
  );
  assert.equal(done.has('age'), false, 'failed instrument must be retried on resume');
  assert.equal(mgr.isLoaded('ga'), false, 'ga must release even on failure');
  assert.equal(mgr.isLoaded('vit'), false, 'vit must release even on failure');
});

test('SIMULATED INTERRUPTION: crash mid-run, resume completes exactly the remainder', async () => {
  const events = [];
  const deps = mockDeps(events);
  const TAB_DEATH = new Error('SIMULATED TAB DEATH');
  // First "page load": run starts, tab dies during telemetry.
  const mgr1 = createModelManager(deps);
  const done = new Set();
  const plan = planLifecycle({ age: true, tele: true, body: true, bust: true });
  const persistedSnapshots = [];
  await assert.rejects(
    runPlannedSteps(plan, done, {
      ensure: m => mgr1.ensure(m),
      release: m => mgr1.release(m),
      runInstrument: async inst => {
        if (inst === 'tele') throw TAB_DEATH; // jetsam here; no finally runs in a real death
        persistedSnapshots.push({ done: [...done], justFinished: inst });
      },
    }),
    /SIMULATED TAB DEATH/
  );
  assert.deepEqual([...done], ['age'], 'only the finished instrument is done');
  // Second "page load": fresh manager, done restored from the persisted record.
  const mgr2 = createModelManager(deps);
  const ran = [];
  await runPlannedSteps(plan, done, {
    ensure: m => mgr2.ensure(m),
    release: m => mgr2.release(m),
    runInstrument: async inst => { ran.push(inst); },
  });
  assert.deepEqual(ran, ['tele', 'body', 'bust'], 'resume must run exactly the remaining instruments');
  assert.deepEqual([...done].sort(), ['age', 'body', 'bust', 'tele']);
  for (const [key] of MODEL_DEFS)
    assert.equal(mgr2.isLoaded(key), false, key + ' lingers after resumed run');
});
