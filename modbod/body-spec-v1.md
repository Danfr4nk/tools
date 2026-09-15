# body-spec v1 — numeric mapping format for modbod

A `body-spec` is a plain JSON file that records a body's numbers separately
from any mesh, so the same spec can be imported into the viewer (or any
future tool) and applied to the parametric model.

## Envelope

```json
{
  "spec": "modbod/body-spec@1",
  "subject": "01",
  "units": "cm",
  "updated": "2026-09-14",
  "measurements": { ... },
  "landmarks": [ ... ],
  "fit": { ... },
  "notes": "..."
}
```

- `spec` must equal `"modbod/body-spec@1"` or the importer rejects the file.
- `units` is `"cm"` for all measurements. Landmark `pos` is in mesh
  normalized units (height = 1, feet at 0), independent of `units`.

## measurements

Named real-world measurements. `null` = unmeasured, never zero, never
guessed. Keys the viewer maps to sliders:

| key      | slider   | baseline (template) | how the baseline was computed |
|----------|----------|---------------------|-------------------------------|
| height   | height   | 165.9               | SMPL-X normalization basis    |
| bust     | bust     | 115.7               | torso perimeter at apex height |
| waist    | waist    | 95.2                | torso perimeter at y=0.61     |
| hips     | hips     | 104.4               | torso perimeter at y=0.5175   |
| thigh    | thighs   | 45.6                | per-leg perimeter at y=0.365  |

Informational only (no slider): `shoulder` (33.1, joint span + flesh
estimate), `torso` (50.0), `leg` (85.8).

**Calibration rule:** `slider = measured_cm / baseline_cm`, clamped to the
slider's min/max on import. The deformation is along surface normals with a
fixed gain per region, so this is approximately linear for small changes and
increasingly approximate at the extremes. Export inverts it:
`measured_cm = slider × baseline_cm`.

There is no glute measurement key — glute projection has no tape-measure
equivalent; the glute slider stays manual.

## landmarks

```json
{"id": "mole.lb.3", "label": "lower-back mole 3", "vertex": 8123,
 "pos": [0.042, 0.612, -0.088], "note": "dark, ~2mm"}
```

- `vertex`: integer index into the template mesh (10475 verts). Preferred —
  pins glued to a vertex follow slider deformation.
- `pos`: `[x, y, z]` fallback when no vertex is known.
- Either may be `null`, but a landmark with both null renders nothing; keep
  it in the file anyway as a placeholder slot with a `note`.
- Template canonical anchors (apex.L/R, waist.min, hip.L/R, glute.max,
  shoulder.L/R, crotch, navel) ship in `baselines.json`, computed off the
  mesh, and render as dim blue pins. Subject landmarks render amber.

## fit

Per-region fit confidence, 0..1, display only:

```json
{"bust": 0.15, "waist": 0.30, "hips": 0.45, "glute": 0.85, "thigh": 0.40}
```

Seed values are coverage-derived priors (how much source material exists per
region), NOT validated reconstruction accuracy. Bust stays low until genuine
source material exists. Never present these as measurement accuracy.

## Starter spec

`specs/subject01.spec.json` — all measurements null (nothing taped yet),
fit seeded from coverage, landmark slots for the 7 lower-back moles + the
left-buttock mole. Fill it in as real numbers land.
