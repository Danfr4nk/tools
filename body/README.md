# body — telemetry mannequin

Import a `breast_telemetry/v1` JSON and the bust rebuilds to scale on a neutral
grey mannequin — in 3D (orbitable, Three.js) and 2D (dimensioned front
schematic). Runs 100% client-side. Nothing is uploaded.

Live: https://danfr4nk.github.io/tools/body/

## files

- `index.html` — page shell, import card, 3D/2D toggle, readout
- `app.js` — Three.js scene (studio lighting, soft shadows, autorotate),
  import wiring, view toggle, readout table. Loads `body-neutral.obj`,
  auto-detects the bust apexes, sculpts the JSON bust in.
- `mannequin.js` — pure bust-sculpt math (no three.js dependency, unit-tested).
  Units are millimetres, y-up, feet at y=0, +z forward.
  - body: baked neutral female mesh — see "base mesh" below. No textures,
    face defeatured, disconnected from any real person by construction.
  - bust: the JSON regenerates ONLY this area. `detectApexes()` finds the
    neutral mesh's bust apexes; the mesh's own small bust is subtracted
    (`bump × moundFalloff`) and the measured profile sculpted in along the
    surface normals — teardrop falloff, inframammary crease, areola/nipple
    micro-geometry + subtle vertex tint. Left mirrored from right.
  - bust POSITION follows the base mesh; the JSON drives SHAPE (width,
    projection, areola, nipple, fold depth). nipLat still feeds the 2D
    schematic and the readout.
  - measured vs modeled is labeled in the readout: apex projection
    (0.45 × mound half-width), bust position, and the left mirror are modeled,
    everything else measured.
  - `bustOffset(dx, dy, T)` is the pure displacement profile (unit-tested);
    `moundFalloff(dx, dy, T)` is the smooth mound component used for the
    neutral-bust subtraction.
- `body-neutral.obj` — the baked neutral mesh (19,158 verts / 36,972 tris),
  generated — never hand-edited. See "base mesh".
- `tests/sculpt.test.js` — `node --test`, zero dependencies. Covers the
  displacement profile, apex detection, sculpt math, and winding, checked
  against the real shipped OBJ.
- `schematic.js` — 2D front-view SVG, 1 unit = 1 mm, origin at fold × cleavage,
  with dimension lines for areola Ø, mound width, nipple→fold
- `validate.js` — `breast_telemetry/v1` schema + validator (mirrors
  `tools/attraction/js/breast.js` without pulling the TF measurement pipeline)

## base mesh

`body-neutral.obj` is derived from MakeHuman (makehumancommunity.org)
**CC0 1.0 Universal** assets — the code is AGPL, but the bundled mesh/target
assets are explicitly CC0 ("the exported models end up being licensed CC0…
you can copy, modify, distribute and perform the work, even for commercial
purposes, all without asking permission" — makehumancommunity.org FAQ).

Bake (reproducible, `~/workspace/mhextract/bake.py` + `defeature.py`):
1. `data/3dobjs/base.obj` (19,158 verts, decimetre units, y-up)
2. \+ average of `data/targets/macrodetails/{caucasian,african,asian}-female-young.target`
   (each a full-body female reshape; the average is the synthetic "universal"
   female — no single ethnicity, maximally anonymized)
3. \+ `data/targets/breast/female-young-averagemuscle-averageweight-mincup-minfirmness.target`
   (small incremental bust reduction, so the JSON sculpts from a neutral base)
4. face defeatured: front-face verts projected onto a smooth plane fit through
   the face boundary (eyes/nose/mouth/lips melted, head volume kept)
5. exported in mm, feet at y=0

To re-bake: run the two scripts, copy the resulting `body-neutral.obj` over
this file. The tool auto-detects apexes at load, so modest mesh changes need
no code updates.

## how measurements map onto the mannequin

| JSON | mannequin |
|---|---|
| `right_nipple` vs `cleavage_x_at_nipple_height_px` × mm/px | nipple lateral offset from centreline |
| `right_fold_y_px` − `right_nipple.y` × mm/px | nipple height above the fold line |
| `right_areola_diameter_mm` | areola dome diameter |
| `right_mound_width_mm` | breast mound base width |
| `cup_estimate.verdict` | readout label (not geometry — band is unmeasured) |

The body below the bust is standard proportion, not measured. Full-body
telemetry (waist, hips, shoulders from future instruments) is the roadmap —
the loft rings in `PARAMS` are built to take it.

## deps

- Three.js 0.160.0 via jsDelivr importmap (no build step)
