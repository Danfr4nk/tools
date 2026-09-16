# body — telemetry mannequin

Import a `breast_telemetry/v1` JSON and the bust rebuilds to scale on a neutral
grey artist's mannequin — in 3D (orbitable, Three.js) and 2D (dimensioned front
schematic). Runs 100% client-side. Nothing is uploaded.

Live: https://danfr4nk.github.io/tools/body/

## files

- `index.html` — page shell, import card, 3D/2D toggle, readout
- `app.js` — Three.js scene (studio lighting, soft shadows, autorotate),
  import wiring, view toggle, readout table
- `mannequin.js` — parametric body. Units are millimetres. `PARAMS` at the top
  holds every proportion (torso loft rings, fold height, materials).
  - body: standard-proportion female mannequin — lofted elliptical torso,
    capsule limbs, relaxed A-pose
  - bust: driven by `deriveParams()` from the JSON — nipple lateral offset and
    height above fold (from px deltas × mm/px), areola diameter and mound
    width (absolute mm), fold crease tube, cleavage implied by the gap
  - left breast mirrored from right (the JSON only resolves the right side)
- `schematic.js` — 2D front-view SVG, 1 unit = 1 mm, origin at fold × cleavage,
  with dimension lines for areola Ø, mound width, nipple→fold
- `validate.js` — `breast_telemetry/v1` schema + validator (mirrors
  `tools/attraction/js/breast.js` without pulling the TF measurement pipeline)

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
