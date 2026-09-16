/* tools/body/app.js — scene, import wiring, view toggle, readout. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARAMS, deriveParams, detectApexes, sculptBust } from './mannequin.js';
import { renderSchematic } from './schematic.js';
import { validateBreastTelemetry, SCHEMA } from './validate.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- sample telemetry (page boots with this) ---------------- */
const SAMPLE = {
  schema: SCHEMA,
  source: 'body-lab sample — import a real JSON to replace',
  image: { w: 2000, h: 2600 },
  method: 'sample',
  assumptions: ['sample values for preview only'],
  scale_model: {
    method: 'fingernail anchor', assumption: 'nail width 14.5 mm',
    nail_width_mm: 14.5, nail_anchor_median_width_px: 96,
    mm_per_px: 0.151, caveat: 'sample', confidence: 'medium', notes: [],
  },
  measured_px: {
    right_nipple: { x: 380, y: 1180 }, left_nipple: { x: 1620, y: 1180 },
    right_areola_diameter_px: 318, left_areola_diameter_px: 318,
    right_mound_width_px: 980, left_mound_width_px: 980,
    right_nipple_to_fold_px: 720, left_nipple_to_fold_px: 720,
    right_fold_y_px: 1900, left_fold_y_px: 1900,
    cleavage_x_at_nipple_height_px: 1000,
    nail_anchor_median_width_px: 96,
    left_breast: 'mirrored from right (sample)',
  },
  modeled_physical: {
    right_areola_diameter_mm: 48, left_areola_diameter_mm: 48,
    right_mound_width_mm: 148, left_mound_width_mm: 148,
    right_nipple_to_fold_mm: 108.7, left_nipple_to_fold_mm: 108.7,
  },
  left_breast: { note: 'mirrored from right (sample)' },
  cup_estimate: {
    method: 'mound-proportion model', assumption: 'band not visible in frame',
    verdict: 'D (34D)', band_table: [[34, 'D']], note: 'sample',
  },
  confidence: {
    areola_diameter: 'medium', mound_width: 'medium', nipple_to_fold: 'medium',
    physical_mm: 'medium', cup: 'low', left_breast: 'low', overall: 'medium',
  },
};

/* ---------------- three.js scene ---------------- */
const container = $('view3d');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
scene.fog = new THREE.Fog(0x0b0e14, 7000, 16000);

const camera = new THREE.PerspectiveCamera(38, 1, 10, 40000);
camera.position.set(340, 1200, 3000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1000, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 900;
controls.maxDistance = 9000;
controls.maxPolarAngle = 1.62;
controls.autoRotate = true;
controls.autoRotateSpeed = -0.7;
renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; }, { once: true });

scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1d24, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.7);
key.position.set(1400, 2400, 1700);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -1400; key.shadow.camera.right = 1400;
key.shadow.camera.top = 2200; key.shadow.camera.bottom = -200;
key.shadow.camera.far = 8000;
key.shadow.bias = -0.0004;
scene.add(key);
const rim = new THREE.DirectionalLight(0x88aaff, 0.8);
rim.position.set(-1600, 1300, -1300);
scene.add(rim);
const fill = new THREE.DirectionalLight(0xfff2e0, 0.35);
fill.position.set(-900, 700, 1800);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(3200, 64),
  new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

function fit() {
  const w = container.clientWidth, h = container.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(fit).observe(container);
window.addEventListener('orientationchange', () => setTimeout(fit, 200));

/* ---------------- base mesh + bust sculpt ---------------- */
// Neutral body, loaded once. Every sculpt starts from these neutral positions
// so re-imports never stack displacement.
let baseCache = null;
async function getBase() {
  if (baseCache) return baseCache;
  const group = await new OBJLoader().loadAsync('body-neutral.obj');
  const g = mergeVertices(group.children[0].geometry); // weld -> indexed -> smooth normals
  g.computeVertexNormals();
  baseCache = {
    pos: g.attributes.position.array.slice(),
    nrm: g.attributes.normal.array.slice(),
    idx: g.index.array,
    apexes: detectApexes(g.attributes.position.array),
  };
  return baseCache;
}

let current = null;
async function setMannequin(T) {
  const hint = $('hint3d');
  try {
    const base = await getBase();
    const { pos, colors } = sculptBust(base.pos, base.nrm, T, base.apexes);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(base.idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: PARAMS.body, roughness: 0.5, metalness: 0.05, vertexColors: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    if (current) {
      scene.remove(current);
      current.geometry.dispose();
      current.material.dispose();
    }
    current = mesh;
    current.userData.material = mat;
    scene.add(current);
    if (hint) hint.textContent = 'drag to orbit · scroll to zoom';
    const ml = $('meshLine');
    if (ml) ml.textContent = 'mesh: ' + (geo.index.count / 3000).toFixed(1) + 'k triangles · one continuous surface · CC0 base';
  } catch (e) {
    if (hint) hint.textContent = 'could not load body-neutral.obj: ' + e.message;
  }
}

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

/* ---------------- render: mannequin + schematic + readout ---------------- */
let lastObj = null;

function renderAll(obj, T) {
  lastObj = obj;
  setMannequin(T); // async — 3D pops in when the mesh is ready
  $('view2d').innerHTML = renderSchematic(T, obj);
  const ph = obj.modeled_physical, cf = obj.confidence || {};
  const rows = [
    ['areola Ø', ph.right_areola_diameter_mm.toFixed(1) + ' mm', cf.areola_diameter],
    ['mound width', ph.right_mound_width_mm.toFixed(1) + ' mm', cf.mound_width],
    ['nipple → fold', ph.right_nipple_to_fold_mm.toFixed(1) + ' mm', cf.nipple_to_fold],
    ['nipple lateral', T.nipLat.toFixed(1) + ' mm from cleavage', '—'],
    ['scale', obj.scale_model.mm_per_px.toFixed(4) + ' mm/px (' + esc(obj.scale_model.method) + ')', obj.scale_model.confidence || '—'],
    ['cup verdict', esc(obj.cup_estimate.verdict), cf.cup],
    ['left breast', esc(obj.measured_px.left_breast || (obj.left_breast && obj.left_breast.note) || '—'), cf.left_breast],
  ];
  let h = '<div class="cup">' + esc(obj.cup_estimate.verdict) + '</div>';
  h += '<table class="rtable">' + rows.map(r =>
    '<tr><td>' + r[0] + '</td><td><b>' + r[1] + '</b></td><td class="dim">' + esc(r[2] || '—') + '</td></tr>'
  ).join('') + '</table>';
  if ((obj.assumptions || []).length)
    h += '<p class="note">assumptions: ' + obj.assumptions.map(esc).join(' · ') + '</p>';
  if (T.notes.length)
    h += '<p class="warn">' + T.notes.map(esc).join('<br>') + '</p>';
  h += '<p class="note">source: ' + esc(obj.source) + ' · left side mirrored from right</p>';
  h += '<p class="note"><span class="dot" style="background:#7ee2a8"></span> measured — nipple offset/height, areola Ø, mound width' +
    '<br><span class="dot" style="background:#ffd479"></span> modeled — apex projection, bust position, left mirror</p>';
  h += '<p class="note" id="meshLine">mesh: loading…</p>';
  $('readout').innerHTML = h;
  fit();
}

function tryImport(text) {
  const st = $('importStatus'), er = $('importErrors');
  er.innerHTML = '';
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { st.innerHTML = '<span class="err">not valid JSON: ' + esc(e.message) + '</span>'; return; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    st.innerHTML = '<span class="err">JSON is not an object.</span>'; return;
  }
  const v = validateBreastTelemetry(obj);
  if (!v.ok) {
    st.innerHTML = '<span class="err">schema check failed — ' + v.errors.length + ' problem(s):</span>';
    er.innerHTML = '<ul class="errlist">' + v.errors.map(e => '<li>' + esc(e) + '</li>').join('') + '</ul>' +
      '<button id="lenient">render anyway (best effort)</button>';
    $('lenient').onclick = () => {
      try {
        const T = deriveParams(obj);
        renderAll(obj, T);
        st.innerHTML = '<span class="ok">rendered best-effort (schema incomplete).</span>';
        er.innerHTML = '';
      } catch (e2) { st.innerHTML = '<span class="err">cannot render: ' + esc(e2.message) + '</span>'; }
    };
    return;
  }
  const T = deriveParams(obj);
  renderAll(obj, T);
  st.innerHTML = '<span class="ok">imported ' + esc(SCHEMA) + ' — mannequin rebuilt.</span>';
}

$('jsonFile').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => tryImport(String(r.result));
  r.onerror = () => { $('importStatus').innerHTML = '<span class="err">could not read file.</span>'; };
  r.readAsText(f);
  e.target.value = '';
});
$('pasteToggle').onclick = () => { $('pasteBox').hidden = !$('pasteBox').hidden; };
$('importText').onclick = () => tryImport($('jsonText').value);

/* ---------------- view toggle ---------------- */
$('tab3d').onclick = () => {
  $('tab3d').classList.add('on'); $('tab2d').classList.remove('on');
  $('view3dWrap').hidden = false; $('view2dWrap').hidden = true; fit();
};
$('tab2d').onclick = () => {
  $('tab2d').classList.add('on'); $('tab3d').classList.remove('on');
  $('view2dWrap').hidden = false; $('view3dWrap').hidden = true;
};

/* ---------------- boot ---------------- */
$('wireToggle').onclick = () => {
  if (!current) return;
  const m = current.userData.material;
  m.wireframe = !m.wireframe;
  $('wireToggle').classList.toggle('on', m.wireframe);
  $('wireToggle').textContent = m.wireframe ? 'wireframe: on' : 'wireframe';
};
renderAll(SAMPLE, deriveParams(SAMPLE));
fit();
