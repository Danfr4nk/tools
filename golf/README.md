# golf — driver swing in 3D

`index.html` is self-contained: the rigged figure (MakeHuman base mesh, GLB), the
baked pose track and a 960×540 copy of the source clip are embedded as base64.
three.js r160 loads from jsDelivr. Open the file directly or serve it from Pages.

## What the viewer does

- Plays, scrubs and steps (← → and Shift for ±10) through 840 frames. Speeds are 0.25× to 2×, and there is a loop toggle.
- Camera presets: true **face-on** (golfer faces +z, target is +x), **down-the-line**,
  **top-down** and **source camera**, which is the solved pose of the phone. Orbit, zoom and pan work everywhere.
- Position chips for P1 address, P2 takeaway, P3 mid-backswing, P4 top, P5 transition, P7 impact, P8 follow-through and P10 finish.
- HUD with hip turn, shoulder turn and x-factor relative to address, taken from the track.
- Club-path trace (amber for the backswing, sage for the downswing), the raw MediaPipe skeleton, a
  picture-in-picture source video, and an "overlay on video" ghost view in the source camera.

## Data corrections (vs. the hand-off pack)

1. **The track was mirrored.** `track_faceon*.json` flips MediaPipe's y but keeps
   its z (+z is *away* from the camera). That gives a reflected, left-handed skeleton.
   The bake negates z.
2. **The "face-on" clip is down-the-line.** The camera sits behind a right-handed
   golfer looking down the target line. Fresh MediaPipe 2D landmarks plus a per-frame
   translation solve (f = 1650 px) recover the camera pose. That pose is the
   "Source camera" preset.
3. **`hipsDx` is ~1.4× too large.** `pxPerMeter` assumed a 0.223 m hip width, but the
   hips are foreshortened in profile. Root sway now comes from the camera solve
   (x and y). Depth sway is dropped because scale-from-depth is noise.
4. **No `club` field exists in the raw file.** Only `clubDir`, the image angle. Shaft depth
   comes from a swing-plane model: the hand-path angle plus a wrist-hinge profile anchored at
   top f450 and impact f624. That model is fused with a back-projection of the image angle
   through the solved camera. Through impact (±25 frames) the shaft is steered at the ball.
5. **The GLB carries MakeHuman fitting helpers** (tights, skirt, hair helmet, joint cubes,
   proxy) in the same primitive. Its normal map is solid black and its roughness map is
   solid magenta. The viewer keeps only the body and eyeballs, drops both maps, and adds
   procedural skin, shirt, shorts, shoes and hair in the shader.
6. The clip is slow motion. 840 frames cover 28 s of video, so the clock shows video seconds.
7. `dan_dtl.mov` is a different session (different clothes and day), not a second angle of this swing.

## Pipeline (`pipeline/`)

`mp_run.py` → `mp2d.json` (MediaPipe heavy, every frame) · `cam.py` (focal / rotation fit)
· `bake.py` → `baked.json` (golfer-frame joints, root sway, club direction, camera)
· `build.py` (embeds into `golf.src.html` → `index.html`). Needs mediapipe, opencv,
numpy and scipy, plus the pack files beside it. The retargeting itself (pelvis/chest
bases, two-bone IK for arms and legs, planted feet with heel roll, forearm twist
split, zero-phase quaternion smoothing) runs in the page at load.
