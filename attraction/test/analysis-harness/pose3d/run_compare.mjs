// Before/after: live (old) telemetry.js vs patched telemetry.js on REAL
// detector output (landmarks + face matrix dumped from the model in Python).
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const IDS = ['btnCopy','btnCsv','btnJson','calibIpd','colA','colB','compareCard','compareNames',
  'deltaTable','dropzone','exportCard','fileInput','history','layerDims','layerFifths','layerGrid',
  'layerIris','layerMesh','layerMetrics','layerMidline','layerThirds','methodBody','metricGroups',
  'metricsCard','modelStatus','overlay','qualityBox','vecCount','viewTitle','viewerCard','statusMsg'];
const dom = new JSDOM(`<!DOCTYPE html><html><body>${
  IDS.map(id => `<div id="${id}"></div>`).join('')
}<input id="calibIpd" value=""/><canvas id="overlay"></canvas></body></html>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// canvas 2d stub (jsdom has no canvas package here)
const overlay = document.getElementById('overlay');
overlay.getContext = () => new Proxy({}, { get: (t, p) => (p === 'canvas' ? overlay : (...a) => {}) });

const data = JSON.parse(fs.readFileSync('/tmp/pose_test.json', 'utf8'));
const { w, h } = data;
const lm = data.landmarks;
const matrix = data.matrix;

const oldMod = await import('/tmp/pose_before/telemetry.js');
const newMod = await import('/home/hatch/workspace/attraction-guide/js/telemetry.js');

const before = oldMod.computeTelemetry(lm, w, h);
const after = newMod.computeTelemetry(lm, w, h, matrix);
const afterFallback = newMod.computeTelemetry(lm, w, h, null);

const keys = ['roll_deg','yaw_deg','pitch_deg','yaw_proxy_deg','frontality',
  'canthal_tilt_L','canthal_tilt_R','canthal_tilt_mean','asymmetry_9','mean_asymmetry'];
console.log('image', `${w}x${h}`, '| landmarks', lm.length);
console.log('pose source (after):', after.poseSource, '| (fallback test):', afterFallback.poseSource);
console.log('---');
console.log('metric             before(old code)   after(3D)      after(2D fallback)');
for (const k of keys) {
  const b = before.metrics[k], a = after.metrics[k], f = afterFallback.metrics[k];
  const fmt = v => v == null ? '—' : (typeof v === 'number' ? v.toFixed(2) : String(v));
  console.log(`${k.padEnd(18)} ${fmt(b).padStart(10)} ${fmt(a).padStart(14)} ${fmt(f).padStart(16)}`);
}
console.log('---');
console.log('quality before/after:', before.quality, '/', after.quality);
console.log('poseFromMatrix direct:', JSON.stringify(newMod.poseFromMatrix(matrix)));
console.log('poseFromMatrix(null):', JSON.stringify(newMod.poseFromMatrix(null)));
console.log('poseFromMatrix(garbage):', JSON.stringify(newMod.poseFromMatrix({data:[1,2,3]})));
