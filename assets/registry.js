/* tools — instrument registry.
 *
 * ONE source of truth for the site shell: the rack, the filters, the command
 * palette, the dependency map and the vault all read from here. Nothing in this
 * file is loaded by any instrument — adding a tool means adding an entry here
 * and dropping its directory in; no instrument code is ever touched.
 *
 * Fields
 *   id       stable slug (also the graph node id)
 *   name     display name, as the instrument titles itself
 *   href     relative path from repo root (site is served at /tools/)
 *   domain   face | body | psych | music | media | text
 *   badge    optional short tag rendered top-right
 *   kicker   one line, lowercase, what it is
 *   blurb    two-ish sentences, what it does
 *   posture  { device, net, weight }  — see POSTURE below
 *   facts    short factual bullets (counts, methods)
 *   deps     keys into DEPS — drives the MAP view
 *   keys     localStorage keys this instrument owns — drives the VAULT
 *   subs     deep links (sibling pages, archived versions, CLIs)
 *   kw       extra search keywords for the palette
 */

export const META = {
  repo: 'https://github.com/danfr4nk/tools',
  pages: 'https://danfr4nk.github.io/tools/',
};

/* posture.net
 *   'none'   — nothing leaves the page and nothing is fetched after load
 *   'models' — downloads model weights once, then cached by the browser
 *   'cdn'    — pulls a library/runtime from a CDN at load
 *   'api'    — talks to a third-party API while you use it
 * posture.device — true when every computation happens on your machine
 */
export const DOMAINS = [
  { id: 'face',  label: 'FACE' },
  { id: 'body',  label: 'BODY' },
  { id: 'psych', label: 'PSYCH' },
  { id: 'music', label: 'MUSIC' },
  { id: 'media', label: 'MEDIA' },
  { id: 'text',  label: 'TEXT' },
];

export const DEPS = {
  measure:      { label: 'attraction/js/measure.js', kind: 'shared', note: 'FaceLandmarker wrapper + the shared ratio vector' },
  breast:       { label: 'attraction/js/breast.js',  kind: 'shared', note: 'breast_telemetry/v1 schema + validator' },
  bodyjs:       { label: 'attraction/js/body.js',    kind: 'shared', note: 'MediaPipe Pose → 16 scale-invariant body ratios' },
  pipeline:     { label: 'kinship/pipeline.js',      kind: 'shared', note: 'SCRFD → align → ArcFace → genderage, in the browser' },
  songnotes:    { label: 'music/shared/song-notes.js', kind: 'shared', note: 'per-track "why?" notes, shared across the ranker tools' },
  h2pengine:    { label: 'hook2piano engine (py)',   kind: 'shared', note: 'the same Python package the CLI runs, executed under Pyodide' },

  scrfd:        { label: 'SCRFD detector',    kind: 'model', note: '17 MB · bundled in kinship/models/' },
  buffalo:      { label: 'buffalo_l ArcFace', kind: 'model', note: '174 MB recognition model · HuggingFace (immich-app), lazy-loaded' },
  fairface:     { label: 'FairFace ViT',      kind: 'model', note: '~50 MB q4f16 ONNX age-bracket classifier · HuggingFace' },
  facelm:       { label: 'FaceLandmarker',    kind: 'model', note: '~5 MB MediaPipe face mesh · Google model CDN' },
  poselm:       { label: 'PoseLandmarker',    kind: 'model', note: 'MediaPipe pose model · Google model CDN' },

  mediapipe:    { label: 'MediaPipe Tasks',   kind: 'cdn', note: '@mediapipe/tasks-vision · jsDelivr' },
  onnxruntime:  { label: 'ONNX Runtime Web',  kind: 'cdn', note: 'WASM/SIMD inference runtime · jsDelivr' },
  transformers: { label: 'Transformers.js',   kind: 'cdn', note: '@huggingface/transformers · jsDelivr' },
  three:        { label: 'three.js 0.160',    kind: 'cdn', note: 'jsDelivr importmap · no build step' },
  pyodide:      { label: 'Pyodide 0.26',      kind: 'cdn', note: 'CPython in WASM' },

  spotify:      { label: 'Spotify embed',     kind: 'api', note: 'track player iframe' },
  reccobeats:   { label: 'ReccoBeats API',    kind: 'api', note: 'tempo / energy / valence lookup per track' },
  hooktheory:   { label: 'Hooktheory API',    kind: 'api', note: 'public TheoryTab project endpoint (+ CORS relay)' },
  youtube:      { label: 'YouTube IFrame API', kind: 'api', note: 'player control' },
  llm:          { label: 'vision LLM API',    kind: 'api', note: 'bring your own key — nothing is proxied' },
};

export const INSTRUMENTS = [
  {
    id: 'workbench', name: 'WORKBENCH', href: 'workbench/', domain: 'face', badge: 'FLAGSHIP',
    kicker: 'one photo in · every instrument out',
    blurb: 'Shared face detection fans out to age estimation, facial telemetry and kinship comparison in a single pass — no re-uploading, no re-cropping per tool. One unified report, JSON export, re-importable later.',
    posture: { device: true, net: 'models', weight: '~250 MB first run, then cached' },
    facts: ['SCRFD · ArcFace · ViT-Base · FaceLandmarker', 'reads back workbench and breast_telemetry/v1 JSON'],
    deps: ['pipeline', 'measure', 'breast', 'onnxruntime', 'mediapipe', 'scrfd', 'buffalo', 'fairface', 'facelm'],
    keys: [], subs: [],
    kw: ['fan out', 'unified report', 'onnx', 'multi face', 'chips'],
  },
  {
    id: 'preference', name: 'PREFERENCE DIAGNOSTIC', href: 'attraction/game.html', domain: 'face', badge: 'ADAPTIVE',
    kicker: 'a/b mapping of what a face has to have',
    blurb: 'Phase 1 sweeps structural archetypes; phase 2 adaptively isolates one variable — jaw, lips, eyes, brows, nose. Every pick is scored on measured metric deltas, z-scored against the bank, not on the label you were shown.',
    posture: { device: true, net: 'models', weight: '~5 MB landmarker' },
    facts: ['155-face synthetic bank · eye colour pinned', '1 pick = weak · 2 = leaning · 3+ = confirmed'],
    deps: ['measure', 'mediapipe', 'facelm'],
    keys: ['attraction-guide-run-v2', 'attraction-guide-prefs-v1'],
    subs: [{ label: 'instrument index', href: 'attraction/', note: 'the suite hub' }],
    kw: ['attraction', 'game', 'archetype', 'jaw', 'lips', 'brow', 'z-score'],
  },
  {
    id: 'telemetry', name: 'TELEMETRY LAB', href: 'attraction/telemetry.html', domain: 'face', badge: 'MEASURE',
    kicker: 'standalone precision facial measurement',
    blurb: 'Upload portraits, get a ~40-metric vector: gonial angles, facial thirds, fWHR, canthal tilt, regional asymmetry, head pose with a 3D matrix fit. Telestrator overlays, landmark-noise 95% intervals, JSON/CSV export.',
    posture: { device: true, net: 'models', weight: '~5 MB landmarker' },
    facts: ['same detector as the diagnostic · roll-corrected canons', 'scale via iris anchor or calibrated IPD'],
    deps: ['measure', 'mediapipe', 'facelm'],
    keys: [], subs: [],
    kw: ['gonial', 'fwhr', 'canthal', 'asymmetry', 'pose', 'csv', 'overlay'],
  },
  {
    id: 'age', name: 'AGE', href: 'age/', domain: 'face', badge: 'ON-DEVICE',
    kicker: 'how old does this face read',
    blurb: 'A ViT-Base classifier fine-tuned on FairFace age brackets runs entirely in the browser. The headline number is the probability-weighted mean of bracket midpoints — read it as ± one bracket, not a birthday.',
    posture: { device: true, net: 'models', weight: '~50 MB ONNX, cached after first run' },
    facts: ['9 brackets: 0-2 … 70+ · full distribution shown', 'CLI twin (age.py) runs the same weights in PyTorch'],
    deps: ['transformers', 'fairface'],
    keys: [],
    subs: [{ label: 'age.py — CLI', href: 'https://github.com/danfr4nk/tools/blob/main/age/age.py', note: 'python age.py photo.jpg --json', ext: true }],
    kw: ['fairface', 'vit', 'transformers.js', 'bracket', 'apparent age'],
  },
  {
    id: 'kinship', name: 'KINSHIP', href: 'kinship/', domain: 'face', badge: 'RESEMBLANCE',
    kicker: 'two photos · one angular distance',
    blurb: 'ArcFace embeddings and cosine similarity produce a resemblance score with verdict bands and a heuristic confidence. Explicitly not a kinship test — the confidence curve has no sibling cohort behind it and the tool says so on the page.',
    posture: { device: true, net: 'models', weight: '17 MB bundled + 174 MB lazy' },
    facts: ['browser pipeline validated against the CLI (cosine within 4e-6)', 'scores ≥0.45 trip a same-person warning'],
    deps: ['pipeline', 'onnxruntime', 'scrfd', 'buffalo'],
    keys: [],
    subs: [{ label: 'kinship.py — CLI', href: 'https://github.com/danfr4nk/tools/blob/main/kinship/kinship.py', note: 'needs the face-tag venv (InsightFace)', ext: true }],
    kw: ['sibling', 'arcface', 'cosine', 'insightface', 'buffalo_l', 'related'],
  },
  {
    id: 'facebook', name: 'FACE BOOK', href: 'attraction/face-book.html', domain: 'face', badge: 'BANK',
    kicker: 'the whole face library, browsable',
    blurb: 'Every synthetic face in the bank, filterable by phase, axis and group, with lightbox inspection. Useful as a catalogue and as a sanity check on what the diagnostic is actually sampling from.',
    posture: { device: true, net: 'none', weight: 'images only' },
    facts: ['155 entries · synthetic, none of them real people'],
    deps: [], keys: [], subs: [],
    kw: ['bank', 'catalog', 'faces', 'lightbox', 'phase'],
  },
  {
    id: 'bodymetrics', name: 'BODY METRICS', href: 'attraction/body-metrics.html', domain: 'body', badge: 'MEASURE',
    kicker: 'sixteen scale-invariant body ratios',
    blurb: 'MediaPipe Pose drives 16 ratios with skeleton overlays, per-person models with outlier rejection, and z-scored matching with a per-ratio breakdown. The quantitative sibling to Frame Describe.',
    posture: { device: true, net: 'models', weight: 'pose model, cached' },
    facts: ['models kept in localStorage', 'auxiliary signal — supports, never overrides, face matching'],
    deps: ['bodyjs', 'mediapipe', 'poselm'],
    keys: ['bodymetrics.models.v1'], subs: [],
    kw: ['pose', 'ratios', 'skeleton', 'shoulder', 'hip', 'match'],
  },
  {
    id: 'framedescribe', name: 'FRAME DESCRIBE', href: 'attraction/frame-describe.html', domain: 'body', badge: 'v0.1',
    kicker: 'open-ended read, in your own lexicon',
    blurb: 'Upload a photo and get an exhaustive qualitative description — lead, body inventory, ink inventory, face report, aura. Not measurement: a full verbal read, in the vocabulary you defined.',
    posture: { device: false, net: 'api', weight: 'bring your own key' },
    facts: ['key stays in this browser — nothing is proxied', 'estimates welcome, hedging is not'],
    deps: ['llm'],
    keys: ['fd_provider', 'fd_apiKey', 'fd_model', 'fd_baseUrl', 'fd_custom'],
    subs: [],
    kw: ['vision', 'llm', 'describe', 'lexicon', 'ink', 'aura', 'openai', 'anthropic'],
  },
  {
    id: 'body', name: 'BODY', href: 'body/', domain: 'body', badge: 'MANNEQUIN',
    kicker: 'telemetry json → a bust rebuilt to scale',
    blurb: 'Import a breast_telemetry/v1 JSON and the measured bust is sculpted onto a neutral grey mannequin — orbitable in 3D and dimensioned in 2D, with every number labelled measured or modeled.',
    posture: { device: true, net: 'cdn', weight: 'three.js only' },
    facts: ['CC0 MakeHuman base mesh, face defeatured by construction', 'sculpt math unit-tested against the shipped OBJ'],
    deps: ['three', 'breast'], keys: [], subs: [],
    kw: ['mannequin', '3d', 'schematic', 'bust', 'obj', 'millimetres'],
  },
  {
    id: 'modbod', name: 'MODBOD', href: 'modbod/', domain: 'body', badge: 'WIREFRAME',
    kicker: 'parametric proportion study',
    blurb: 'A SMPL-X female template in a relaxed T-pose, sculpted region by region along surface normals. A coverage overlay paints how much real source material stands behind each vertex — red means statistical prior only.',
    posture: { device: true, net: 'none', weight: 'self-contained page' },
    facts: ['generic statistical prior, not a scan of anyone', 'genital detail omitted by design'],
    deps: [], keys: [], subs: [],
    kw: ['smplx', 'wireframe', 'sliders', 'coverage', 'proportions'],
  },
  {
    id: 'scenariorate', name: 'SCENARIO RATINGS', href: 'attraction/scenario-rate.html', domain: 'psych', badge: 'v3',
    kicker: '234 situations · one knob apart',
    blurb: '78 bases × 2 single-knob modifiers. Each modifier changes exactly one thing, so the readout is causal: what that one change does to your 1–10. A veto drops a question out of scoring entirely; notes attach per line.',
    posture: { device: true, net: 'none', weight: 'self-contained' },
    facts: ['exports scenario-ratings-v3.json'],
    deps: [],
    keys: ['scen_rate_v3', 'scen_rate_v3_x', 'scen_rate_v3_notes'],
    subs: [
      { label: 'alt — LOVE / LIKE / MEH / NO WAY', href: 'attraction/scenario-rate-alt.html', note: '78 bases × 12 modifiers' },
      { label: 'v2', href: 'attraction/scenario-rate-v2.html', note: 'frozen snapshot' },
      { label: 'v1', href: 'attraction/scenario-rate-v1.html', note: 'frozen snapshot' },
    ],
    kw: ['scenario', 'ratings', 'modifier', 'veto', 'causal', 'knob'],
  },
  {
    id: 'scenario', name: 'SCENARIO TELEMETRY', href: 'attraction/scenario.html', domain: 'psych', badge: 'v6',
    kicker: 'named bouts, then metric isolation',
    blurb: 'Run the bout, then every trial shows only what differs between A and B. Veto both, mark reluctance, or pick a side — the output is a preference vector, not a score.',
    posture: { device: true, net: 'none', weight: 'self-contained' },
    facts: ['all scenarios presume consenting adults'],
    deps: [],
    keys: ['scen_tel_v6', 'scen_tel_done_v6', 'scen_tel_v3', 'scen_tel_done_v3', 'scen_diag_trials', 'scen_diag_done', 'scen_diag_trials_v2', 'scen_diag_done_v2'],
    subs: [
      { label: 'v5', href: 'attraction/scenario-v5.html' },
      { label: 'v4', href: 'attraction/scenario-v4.html' },
      { label: 'v3', href: 'attraction/scenario-v3.html' },
      { label: 'v2', href: 'attraction/scenario-v2.html' },
      { label: 'v1', href: 'attraction/scenario-v1.html' },
    ],
    kw: ['bout', 'preset', 'isolation', 'reluctant', 'veto'],
  },
  {
    id: 'musictrainer', name: 'MUSICTRAINER', href: 'music/musictrainer/', domain: 'music', badge: 'SCORECARD',
    kicker: 'the weekly taste experiment',
    blurb: 'Discover Weekly and Release Radar, scored track by track: 1.00–10.00, HATE / LIKE / PLAYLIST, and a prediction paste that timestamps and locks before you listen. Blind test in, week JSON out.',
    posture: { device: true, net: 'api', weight: 'Spotify embed per track' },
    facts: ['target: 240 decisions', 'predictions lock before scoring opens'],
    deps: ['spotify', 'songnotes'],
    keys: ['musictrainer.v1', 'songnotes.v1'], subs: [],
    kw: ['spotify', 'discover weekly', 'release radar', 'prediction', 'blind', 'score'],
  },
  {
    id: 'autopsy', name: 'AUTOPSY', href: 'music/track-autopsy/', domain: 'music', badge: 'DRIVERS',
    kicker: 'what, exactly, did it',
    blurb: 'Per track: triage and score, WHAT DID IT? across 16 drivers, then KILL ONE — the single element you would remove to kill the track. Drivers ranked by lift over your base keep rate.',
    posture: { device: true, net: 'api', weight: 'Spotify embed + ReccoBeats lookup' },
    facts: ['16 drivers · min 2 checks before a driver ranks', 'small sample: early leaders are suspects, not verdicts'],
    deps: ['spotify', 'reccobeats', 'songnotes'],
    keys: ['autopsy.v1', 'songnotes.v1'], subs: [],
    kw: ['drop', 'bass', 'hook', 'lift', 'kill one', 'dissect', 'tempo'],
  },
  {
    id: 'hook2piano', name: 'HOOK2PIANO', href: 'music/hook2piano/docs/', domain: 'music', badge: 'PYODIDE',
    kicker: 'theorytab → printable grand staff',
    blurb: 'Paste a TheoryTab URL or tab ID and get a one-page piano score: left hand on the chords, right hand on the melody, chord symbols and Roman numerals on top. Harmonic view, piano roll and falling notes included.',
    posture: { device: true, net: 'api', weight: 'Pyodide runtime + tab JSON' },
    facts: ['the Python engine itself runs in the browser under WASM', 'relative Hooktheory notation resolved to spelled pitches'],
    deps: ['pyodide', 'hooktheory', 'h2pengine'],
    keys: ['h2p.falling'],
    subs: [
      { label: 'example — Radiohead, Creep', href: 'music/hook2piano/examples/radiohead-creep.html', note: 'rendered output' },
      { label: 'example — TLC, This Is How It Works', href: 'music/hook2piano/examples/tlc-this-is-how-it-works.html', note: 'rendered output' },
      { label: 'hook2piano — CLI', href: 'https://github.com/danfr4nk/tools/tree/main/music/hook2piano', note: 'pip install . ; hook2piano <url>', ext: true },
    ],
    kw: ['theorytab', 'hooktheory', 'vexflow', 'sheet music', 'roman numerals', 'chords'],
  },
  {
    id: 'melody', name: 'MELODY', href: 'music/melody/', domain: 'music', badge: 'ON-DEVICE',
    kicker: 'a finished song → the lead line → midi',
    blurb: 'Upload audio, it finds the lead melody, lays it on a piano roll, plays it back and exports MIDI for your DAW. Runs entirely on your device — nothing is uploaded, nothing is fetched.',
    posture: { device: true, net: 'none', weight: 'zero external requests' },
    facts: ['accepts files by extension too — iOS greys out bare audio/*'],
    deps: [], keys: [], subs: [],
    kw: ['midi', 'piano roll', 'audio', 'transcribe', 'daw', 'wav', 'mp3'],
  },
  {
    id: 'cowatch', name: 'CO-WATCH', href: 'co-watch/', domain: 'media', badge: 'PROTOCOL',
    kicker: 'watch it with someone who cannot see it',
    blurb: 'Video and timed transcript side by side: the current line highlights and auto-scrolls, any line seeks the video, and each line has a ping button that copies a chat-ready timestamp so the conversation stays in sync.',
    posture: { device: true, net: 'api', weight: 'YouTube player' },
    facts: ['transcripts are committed to transcripts.json, keyed by video id'],
    deps: ['youtube'], keys: [], subs: [],
    kw: ['youtube', 'transcript', 'timestamp', 'sync', 'sammy', 'watch'],
  },
  {
    id: 'stylometry', name: 'STYLOMETRY', href: 'https://github.com/danfr4nk/tools/tree/main/stylometry', domain: 'text', badge: 'LOCAL ONLY',
    kicker: 'state tracking from how the writing moves',
    blurb: 'v3 is the semantic layer — what is being said, fused with v2\'s style read through a 2×2 joint matrix. Stdlib Python on a 30-minute loop; the LLM layer fires on triggers only. Not served here, and deliberately so.',
    posture: { device: true, net: 'api', weight: 'runs on the Mac, not in a browser' },
    facts: ['every artifact with message text lives outside this repo, under $STYLO_V3_DATA', 'the root .gitignore is a backstop, not the mechanism'],
    deps: [], keys: [], external: true,
    subs: [
      { label: 'BURNIN-V3.md', href: 'https://github.com/danfr4nk/tools/blob/main/stylometry/v3/BURNIN-V3.md', note: 'the burn-in protocol', ext: true },
      { label: 'ATTACK-V3.md', href: 'https://github.com/danfr4nk/tools/blob/main/stylometry/v3/ATTACK-V3.md', note: 'how it is meant to fail', ext: true },
    ],
    kw: ['python', 'semantic', 'layer a', 'layer b', 'joint', 'burn-in', 'cli'],
  },
];

/* Hubs — the two index pages that group instruments, kept reachable. */
export const HUBS = [
  { id: 'hub-attraction', name: 'attraction — instrument index', href: 'attraction/', note: '7 instruments + frozen version archive' },
  { id: 'hub-music', name: 'music — category index', href: 'music/', note: '4 instruments' },
];

/* ------------------------------------------------------------------ *
 * VAULT — every localStorage key the suite writes, with a summarizer.
 *
 * These are READ with exactly the names the instruments already use. The
 * names are never rewritten: localStorage is per-origin, so a rename would
 * orphan saved runs. (See README: "Do not rename a tool's localStorage keys".)
 * ------------------------------------------------------------------ */
const n = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);
const plural = (c, one, many) => `${c} ${c === 1 ? one : (many || one + 's')}`;

export const STORAGE = [
  {
    key: 'musictrainer.v1', tool: 'musictrainer', label: 'weeks, tracks, predictions',
    sum(v) {
      const w = Array.isArray(v?.weeks) ? v.weeks : [];
      const tracks = w.reduce((a, x) => a + (x.tracks?.length || 0), 0);
      const scored = w.reduce((a, x) => a + (x.tracks || []).filter((t) => t.status && t.status !== 'unscored').length, 0);
      const locked = w.filter((x) => x.predictionsLocked).length;
      return [plural(w.length, 'week'), `${scored}/${tracks} scored`, locked ? `${locked} locked` : null];
    },
  },
  {
    key: 'autopsy.v1', tool: 'autopsy', label: 'tracks + driver picks',
    sum(v) {
      const t = Array.isArray(v?.tracks) ? v.tracks : [];
      const done = t.filter((x) => x.done && x.status !== 'unscored').length;
      const killed = t.filter((x) => x.kill).length;
      return [plural(t.length, 'track'), `${done} dissected`, killed ? `${killed} kill-one picks` : null];
    },
  },
  {
    key: 'songnotes.v1', tool: 'musictrainer', label: 'shared per-track "why?" notes',
    sum(v) { return [plural(Object.keys(v || {}).length, 'note')]; },
  },
  {
    key: 'attraction-guide-run-v2', tool: 'preference', label: 'the current diagnostic run',
    sum(v) {
      const rounds = v?.rounds?.length || 0;
      const retired = Object.values(v?.axisStatus || {}).filter((s) => s !== 'open').length;
      return [`phase ${n(v?.phase) || 1}`, plural(rounds, 'round'), retired ? `${retired}/5 axes closed` : null];
    },
    started: (v) => v?.startedAt || null,
  },
  {
    key: 'attraction-guide-prefs-v1', tool: 'preference', label: 'which face groups are in play', pref: true,
    sum(v) {
      const groups = v && typeof v === 'object' ? Object.keys(v).length : 0;
      return [groups ? `${groups} group settings` : 'defaults'];
    },
  },
  { key: 'scen_rate_v3', tool: 'scenariorate', label: 'v3 ratings', of: 234,
    sum(v) { return [`${Object.keys(v || {}).length} / 234 rated`]; } },
  { key: 'scen_rate_v3_x', tool: 'scenariorate', label: 'v3 question vetoes',
    sum(v) { return [plural(Object.keys(v || {}).length, 'veto')]; } },
  { key: 'scen_rate_v3_notes', tool: 'scenariorate', label: 'v3 per-line notes',
    sum(v) { return [plural(Object.keys(v || {}).length, 'note')]; } },
  { key: 'scen_rate_alt', tool: 'scenariorate', label: 'alt ratings (LOVE/LIKE/MEH/NO WAY)', of: 936,
    sum(v) { return [`${Object.keys(v || {}).length} rated`]; } },
  { key: 'scen_rate_alt_x', tool: 'scenariorate', label: 'alt vetoes',
    sum(v) { return [plural(Object.keys(v || {}).length, 'veto')]; } },
  { key: 'scen_rate_alt_notes', tool: 'scenariorate', label: 'alt notes',
    sum(v) { return [plural(Object.keys(v || {}).length, 'note')]; } },
  { key: 'scen_rate_v2', tool: 'scenariorate', label: 'v2 ratings (archive)',
    sum(v) { return [`${Object.keys(v || {}).length} rated`]; } },
  { key: 'scen_rate_v1', tool: 'scenariorate', label: 'v1 ratings (archive)',
    sum(v) { return [`${Object.keys(v || {}).length} rated`]; } },
  { key: 'scen_tel_v6', tool: 'scenario', label: 'v6 bout trials',
    sum(v) { return [plural(v?.trials?.length || 0, 'trial'), v?.sel?.length ? `${v.sel.length} presets` : null]; } },
  { key: 'scen_tel_done_v6', tool: 'scenario', label: 'v6 completion flag', sum() { return ['complete']; } },
  { key: 'scen_tel_v3', tool: 'scenario', label: 'v3 trials (archive)',
    sum(v) { return [plural(Array.isArray(v) ? v.length : (v?.trials?.length || 0), 'trial')]; } },
  { key: 'scen_tel_done_v3', tool: 'scenario', label: 'v3 completion flag', sum() { return ['complete']; } },
  { key: 'scen_diag_trials', tool: 'scenario', label: 'diagnostic trials (archive)',
    sum(v) { return [plural(Array.isArray(v) ? v.length : 0, 'trial')]; } },
  { key: 'scen_diag_done', tool: 'scenario', label: 'diagnostic flag', sum() { return ['complete']; } },
  { key: 'scen_diag_trials_v2', tool: 'scenario', label: 'diagnostic v2 trials (archive)',
    sum(v) { return [plural(Array.isArray(v) ? v.length : 0, 'trial')]; } },
  { key: 'scen_diag_done_v2', tool: 'scenario', label: 'diagnostic v2 flag', sum() { return ['complete']; } },
  {
    key: 'bodymetrics.models.v1', tool: 'bodymetrics', label: 'per-person body models',
    sum(v) {
      const k = v && typeof v === 'object' ? Object.keys(v) : [];
      const shots = k.reduce((a, x) => a + (Array.isArray(v[x]) ? v[x].length : (v[x]?.samples?.length || 0)), 0);
      return [plural(k.length, 'model'), shots ? plural(shots, 'sample') : null];
    },
  },
  { key: 'h2p.falling', tool: 'hook2piano', label: 'falling-notes view prefs', pref: true, sum() { return ['view prefs']; } },
  { key: 'fd_provider', tool: 'framedescribe', label: 'vision provider', pref: true, sum(v) { return [String(v)]; } },
  { key: 'fd_model', tool: 'framedescribe', label: 'vision model', pref: true, sum(v) { return [String(v)]; } },
  { key: 'fd_baseUrl', tool: 'framedescribe', label: 'vision base URL', pref: true, sum(v) { return [String(v)]; } },
  { key: 'fd_custom', tool: 'framedescribe', label: 'custom prompt', pref: true, sum(v) { return [`${String(v || '').length} chars`]; } },
  { key: 'fd_apiKey', tool: 'framedescribe', label: 'vision API key', secret: true, sum() { return ['held in this browser only']; } },
  { key: 'tools.site.v1', tool: null, label: 'this page — view, theme, filters', own: true, sum() { return ['site prefs']; } },
];

export const BY_ID = Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i]));
