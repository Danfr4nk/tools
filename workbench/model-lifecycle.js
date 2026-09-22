/* workbench/model-lifecycle.js — lazy, sequential, disposable model management.
 *
 * Pure + DOM-free (node-testable). The workbench runs instruments in a fixed
 * order (age -> tele -> body -> bust). This module computes exactly which
 * models each selected instrument needs, ensures each model loads only when
 * first needed, and releases it after the last instrument needing it finishes.
 *
 * Peak memory is one model at a time (two, briefly, while the body anchor
 * reuses telemetry's resident landmarker). The 174MB ArcFace recognition
 * model is deliberately absent from every plan: no workbench instrument needs
 * ArcFace embeddings — the age card's 2nd opinion reads sex/age from
 * genderage.onnx (1.3MB), and the embedding vector itself was never used.
 */

export const MODEL_DEFS = [
  ['det', 'face detection — SCRFD'],
  ['ga', 'gender + age — genderage'],
  ['vit', 'age classifier — ViT'],
  ['land', 'face landmarks — MediaPipe'],
  ['pose', 'body pose — MediaPipe'],
  ['seg', 'segmentation — MediaPipe'],
];

export const RUN_ORDER = ['age', 'tele', 'body', 'bust'];

// Models each instrument needs resident while it runs. `det` is handled by
// the detection step (faces are plain data afterwards, the model releases).
// `land` for the body instrument is opportunistic — the face anchor uses
// landmarks only when the landmarker is already resident from facial
// telemetry; a body-only run never pulls it (bbox-only anchor instead).
const NEEDS = {
  age: ['ga', 'vit'],
  tele: ['land'],
  body: ['pose'],
  bust: ['pose'],
};

// sel: {age, tele, body, bust} booleans (face-gating already applied).
// Returns { detect: bool, steps: [{instrument, load: [...], release: [...]}] }.
export function planLifecycle(sel) {
  const active = RUN_ORDER.filter(k => sel[k]);
  const detect = active.includes('age') || active.includes('tele') || active.includes('bust');
  const lastNeed = {};
  for (const inst of active)
    for (const m of NEEDS[inst]) lastNeed[m] = inst;
  // The body instrument's face anchor reuses the landmarker when facial
  // telemetry ran first in the same run — so it releases after body, not
  // after telemetry.
  if (sel.tele && sel.body) lastNeed.land = 'body';
  const steps = active.map(inst => ({
    instrument: inst,
    load: [...NEEDS[inst]],
    release: Object.keys(lastNeed).filter(m => lastNeed[m] === inst),
  }));
  return { detect, steps };
}

// deps: { load(key, onProgress) -> handle, dispose(key, handle),
//         onStatus(key, state, pct) } — state in idle|loading|ready|released.
// The handle is opaque; dispose receives the exact handle load returned.
export function createModelManager(deps) {
  const loaded = {};
  const states = {};
  async function ensure(key) {
    if (loaded[key] !== undefined) return loaded[key];
    states[key] = 'loading';
    if (deps.onStatus) deps.onStatus(key, 'loading');
    try {
      const handle = await deps.load(key, pct => {
        if (deps.onStatus) deps.onStatus(key, 'loading', pct);
      });
      loaded[key] = handle;
      states[key] = 'ready';
      if (deps.onStatus) deps.onStatus(key, 'ready');
      return handle;
    } catch (e) {
      states[key] = 'idle';
      if (deps.onStatus) deps.onStatus(key, 'idle');
      throw e;
    }
  }
  async function release(key) {
    const handle = loaded[key];
    delete loaded[key]; // reference dropped FIRST — nothing lingers even if dispose throws
    if (handle !== undefined) {
      try { await deps.dispose(key, handle); } catch (e) { /* best-effort */ }
    }
    states[key] = 'released';
    if (deps.onStatus) deps.onStatus(key, 'released');
  }
  async function releaseAll() {
    for (const key of Object.keys(loaded)) await release(key);
  }
  return {
    ensure,
    release,
    releaseAll,
    handle: key => loaded[key],
    isLoaded: key => loaded[key] !== undefined,
    state: key => states[key] || 'idle',
  };
}

// Drives the planned steps, skipping already-done instruments (crash resume).
// hooks: { ensure(model), release(model), runInstrument(instrument),
//          onInstrumentDone(instrument) }.
// done: a Set of completed instrument keys (mutated as steps complete).
// An instrument that throws is NOT marked done, so a resume retries it;
// its models still release via the finally.
export async function runPlannedSteps(plan, done, hooks) {
  for (const step of plan.steps) {
    if (done.has(step.instrument)) continue;
    for (const m of step.load) await hooks.ensure(m);
    try {
      await hooks.runInstrument(step.instrument);
      done.add(step.instrument);
      if (hooks.onInstrumentDone) await hooks.onInstrumentDone(step.instrument);
    } finally {
      for (const m of step.release) await hooks.release(m);
    }
  }
}
