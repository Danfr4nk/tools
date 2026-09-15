// Decompose the rotation-battery matrices with the shipped poseFromMatrix.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
const IDS = ['btnCopy','btnCsv','btnJson','calibIpd','colA','colB','compareCard','compareNames',
  'deltaTable','dropzone','exportCard','fileInput','history','layerDims','layerFifths','layerGrid',
  'layerIris','layerMesh','layerMetrics','layerMidline','layerThirds','methodBody','metricGroups',
  'metricsCard','modelStatus','overlay','qualityBox','vecCount','viewTitle','viewerCard','statusMsg'];
const dom = new JSDOM(`<!DOCTYPE html><html><body>${
  IDS.map(id => `<div id="${id}"></div>`).join('')
}<input id="calibIpd" value=""/><canvas id="overlay"></canvas></body></html>`);
globalThis.window = dom.window; globalThis.document = dom.window.document;
const overlay = document.getElementById('overlay');
overlay.getContext = () => new Proxy({}, { get: (t, p) => (p === 'canvas' ? overlay : (...a) => {}) });
const { poseFromMatrix } = await import('/home/hatch/workspace/attraction-guide/js/telemetry.js');
const bat = JSON.parse(fs.readFileSync('/tmp/rot_battery.json', 'utf8'));
for (const ang of ['0', '10', '-10']) {
  const b = bat[ang];
  const p = poseFromMatrix({ rows: 4, columns: 4, data: b.matrix });
  console.log(`img-rot ${ang}°: yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)} roll=${p.roll.toFixed(2)} | proxy yaw=${b.yaw_proxy.toFixed(2)} roll(ac)=${b.roll_proxy_ac.toFixed(2)}`);
}
