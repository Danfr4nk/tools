import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';

// Don't use remote models other than the one we specify; keep cache local.
env.allowRemoteModels = true;

const MODEL_ID = 'onnx-community/fairface_age_image_detection-ONNX';
const DTYPE = 'q4f16'; // ~50MB, good speed/accuracy tradeoff for browsers

const LABELS = ['0-2','3-9','10-19','20-29','30-39','40-49','50-59','60-69','more than 70'];
const MIDPOINTS = [1, 6, 14.5, 24.5, 34.5, 44.5, 54.5, 64.5, 78];

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), preview = $('preview'), hint = $('hint');
const runstate = $('runstate'), result = $('result');
const modellabel = $('modellabel'), modelfill = $('modelfill');

let classifier = null;
let modelReady = false;

function setProgress(pct, label) {
  modelfill.style.width = (pct * 100).toFixed(1) + '%';
  if (label) modellabel.textContent = label;
}

async function loadModel() {
  setProgress(0, 'model: downloading…');
  try {
    classifier = await pipeline('image-classification', MODEL_ID, {
      dtype: DTYPE,
      progress_callback: (ev) => {
        if (ev.status === 'progress' && ev.progress != null) {
          // progress is per-file; show file name + bar
          const f = (ev.file || '').split('/').pop();
          setProgress(Math.min(0.99, ev.progress), 'model: downloading ' + f);
        } else if (ev.status === 'done') {
          setProgress(1, 'model: ready');
        } else if (ev.status === 'initiate') {
          setProgress(0, 'model: starting download…');
        }
      },
    });
    modelReady = true;
    setProgress(1, 'model: ready (local inference)');
  } catch (e) {
    modellabel.innerHTML = '<span class="err">model failed to load: ' + escapeHtml(String(e.message || e)) + '</span>';
    console.error(e);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// Crop the largest detected face (with margin), else center-square crop.
// Returns { canvas, note }.
async function faceCrop(img) {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  let box = null;
  let method = 'center crop';

  if ('FaceDetector' in window) {
    try {
      const detector = new FaceDetector({ fastMode: false });
      // draw to a temp canvas for detection (cap size for speed)
      const scale = Math.min(1, 800 / Math.max(iw, ih));
      const tc = document.createElement('canvas');
      tc.width = Math.round(iw * scale); tc.height = Math.round(ih * scale);
      tc.getContext('2d').drawImage(img, 0, 0, tc.width, tc.height);
      const faces = await detector.detect(tc);
      if (faces && faces.length) {
        // largest face, mapped back to original coords
        faces.sort((a, b) =>
          (b.boundingBox.width * b.boundingBox.height) - (a.boundingBox.width * a.boundingBox.height));
        const f = faces[0].boundingBox;
        box = {
          x: f.x / scale, y: f.y / scale,
          w: f.width / scale, h: f.height / scale,
        };
        method = 'face detected (' + faces.length + ' found, largest used)';
      }
    } catch (e) {
      console.warn('FaceDetector failed, falling back to center crop', e);
    }
  }

  let sx, sy, side;
  if (box) {
    // expand by 25% margin, force square
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    side = Math.max(box.w, box.h) * 1.5;
    sx = Math.max(0, cx - side / 2); sy = Math.max(0, cy - side / 2);
    side = Math.min(side, iw - sx, ih - sy);
  } else {
    side = Math.min(iw, ih);
    sx = (iw - side) / 2; sy = (ih - side) / 2;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 224; canvas.height = 224;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, side, side, 0, 0, 224, 224);
  return { canvas, note: method };
}

async function classify(canvas) {
  // top_k: 9 → all classes
  const out = await classifier(canvas, { top_k: 9 });
  // normalize to label order
  const probs = {};
  for (const r of out) probs[r.label] = r.score;
  return LABELS.map(l => ({ label: l, score: probs[l] || 0 }));
}

function render(probs, cropCanvas, note) {
  // draw crop preview
  const cc = $('crop').getContext('2d');
  cc.drawImage(cropCanvas, 0, 0);

  const expected = probs.reduce((s, p, i) => s + p.score * MIDPOINTS[i], 0);
  const top = probs.reduce((a, b) => (b.score > a.score ? b : a));

  $('agenum').textContent = expected.toFixed(1);
  $('bracket').textContent = top.label;
  $('bracketconf').textContent = '· ' + (top.score * 100).toFixed(1) + '% confidence';
  $('cropnote').textContent = 'classified region: ' + note + '.';

  const dist = $('dist');
  dist.innerHTML = '';
  const maxScore = Math.max(...probs.map(p => p.score));
  for (const p of probs) {
    const row = document.createElement('div');
    row.className = 'drow' + (p.label === top.label ? ' top' : '');
    const w = maxScore > 0 ? (p.score / maxScore * 100) : 0;
    row.innerHTML =
      '<span class="lbl">' + escapeHtml(p.label) + '</span>' +
      '<span class="bar"><div style="width:' + w.toFixed(1) + '%"></div></span>' +
      '<span class="pct">' + (p.score * 100).toFixed(1) + '%</span>';
    dist.appendChild(row);
  }
  result.classList.add('show');
}

async function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  runstate.textContent = '';
  result.classList.remove('show');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
  hint.style.display = 'none';

  if (!modelReady) {
    runstate.textContent = 'waiting for model to finish downloading…';
    // wait until ready (poll)
    while (!modelReady) {
      await new Promise(r => setTimeout(r, 500));
      if (modellabel.querySelector('.err')) { runstate.textContent = ''; return; }
    }
    runstate.textContent = '';
  }

  try {
    runstate.textContent = 'finding face…';
    const img = await loadImage(file);
    const { canvas, note } = await faceCrop(img);
    runstate.textContent = 'estimating age…';
    // let the UI breathe
    await new Promise(r => setTimeout(r, 30));
    const probs = await classify(canvas);
    render(probs, canvas, note);
    runstate.textContent = '';
  } catch (e) {
    console.error(e);
    runstate.innerHTML = '<span class="err">failed: ' + escapeHtml(String(e.message || e)) + '</span>';
  }
}

drop.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); });
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
// pasting an image works too
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) handleFile(item.getAsFile());
});

loadModel();
