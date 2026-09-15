// Minimal loader for headless computeTelemetry tests: stubs the MediaPipe
// npm import and short-circuits ensureLandmarker (no model download).
const MEDIAPIPE_STUB = 'data:text/javascript,export const FaceLandmarker = {}; export const FilesetResolver = {};';
export async function resolve(specifier, context, next) {
  if (specifier === '@mediapipe/tasks-vision')
    return { url: MEDIAPIPE_STUB, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  const res = await next(url, context);
  if (url.endsWith('/js/measure.js') && res.source) {
    let src = res.source.toString();
    src = src.replace(
      /export async function ensureLandmarker\(onStatus\) \{[\s\S]*?\n\}\n\nexport function measurementReady\(\)/,
      `export async function ensureLandmarker(onStatus) { ready = true; onStatus && onStatus('landmarks ready'); return {}; }\n\nexport function measurementReady()`
    );
    if (!src.includes("return {}; }"))
      throw new Error('ensureLandmarker stub injection failed for ' + url);
    return { format: res.format, source: src, shortCircuit: true };
  }
  return res;
}
