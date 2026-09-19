/* tools/body/schematic.js — 2D front-view technical schematic of the bust.
 * Units are millimetres, origin at (cleavage, fold), y grows downward.
 * Drawn to scale from the same derived params as the 3D mannequin.
 */

export function renderSchematic(T, obj) {
  const { nipLat, nipUp, moundW, areolaD } = T;
  const F = nipLat + moundW / 2 + 30;   // fold line half-length
  // y-down SVG: the nipple sits ABOVE the fold, so the bust is at negative y.
  // (v3.4 fixed a sign error that drew the bust below the fold line.)
  const ny = -nipUp;
  const W = 300, H1 = 300;
  // headroom for the measured contour (it can tower over the modeled bust)
  const cTop = (T.contourMm || []).reduce((m, p) => Math.max(m, p.dy), 0);
  const H0 = Math.min(-230, ny - cTop - 24);
  const L = '#7dd3fc', B = '#a78bfa', D = '#9aa3b2', Tx = '#cfd6e4', Faint = '#3a4150';
  const M = '#7ee2a8';                  // measured-geometry green

  // left-half torso outline, mirrored for the right side
  const torsoPath =
    'M -42 -215 L -42 -180 ' +                 // neck
    'C -90 -172, -140 -162, -186 -148 ' +      // trapezius -> shoulder
    'C -208 -120, -216 -80, -218 -36 ' +       // upper arm outer
    'C -200 -20, -182 -12, -168 4 ' +          // armpit in
    'C -158 40, -150 80, -146 118 ' +          // ribcage -> waist
    'C -158 160, -172 190, -178 230 ' +        // waist -> hip
    'L -170 300';                              // down past frame

  const dim = (x1, y1, x2, y2, label, lx, ly) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${L}" stroke-width="1.4"/>` +
    `<circle cx="${x1}" cy="${y1}" r="2.4" fill="${L}"/><circle cx="${x2}" cy="${y2}" r="2.4" fill="${L}"/>` +
    `<text x="${lx}" y="${ly}" fill="${Tx}" font-size="13" text-anchor="middle" font-family="inherit">${label}</text>`;

  const side = (s) => {
    const nx = s * nipLat;
    // Areola: measured ellipse when the telemetry carries one, circle fallback.
    // Front view here, so the person's right (measured) breast is viewer's-left
    // (s=-1); the other side gets the mirrored angle.
    const el = T.areolaEllipse;
    const aDeg = el ? el.ang * 180 / Math.PI : 0;
    const rot = s === 1 ? 180 - aDeg : aDeg;
    const areolaSvg = el
      ? `<ellipse cx="${nx}" cy="${ny}" rx="${el.a.toFixed(1)}" ry="${el.b.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${nx} ${ny})" fill="rgba(125,211,252,.12)" stroke="${L}" stroke-width="1.6"/>`
      : `<circle cx="${nx}" cy="${ny}" r="${(areolaD / 2).toFixed(1)}" fill="rgba(125,211,252,.12)" stroke="${L}" stroke-width="1.6"/>`;
    const aLab = el ? el.a : areolaD / 2, bLab = el ? el.b : areolaD / 2;
    // Measured breast contour, nipple-centered mm → schematic coords.
    const cpts = (T.contourMm || []).map(p =>
      (s * (nipLat + p.dx)).toFixed(1) + ',' + (ny - p.dy).toFixed(1)).join(' ');
    const contourSvg = cpts
      ? `<polyline points="${cpts}" fill="none" stroke="${M}" stroke-width="1.4" opacity="0.9"/>` : '';
    return `
    ${contourSvg}
    <line x1="${s * (nipLat - moundW / 2)}" y1="${ny + 52}" x2="${s * (nipLat + moundW / 2)}" y2="${ny + 52}" stroke="${B}" stroke-width="1.6"/>
    <line x1="${s * (nipLat - moundW / 2)}" y1="${ny + 46}" x2="${s * (nipLat - moundW / 2)}" y2="${ny + 58}" stroke="${B}" stroke-width="1.6"/>
    <line x1="${s * (nipLat + moundW / 2)}" y1="${ny + 46}" x2="${s * (nipLat + moundW / 2)}" y2="${ny + 58}" stroke="${B}" stroke-width="1.6"/>
    <text x="${nx}" y="${ny + 74}" fill="${Tx}" font-size="12.5" text-anchor="middle" font-family="inherit">mound ${moundW.toFixed(0)} mm</text>
    ${areolaSvg}
    <circle cx="${nx}" cy="${ny}" r="4" fill="${L}"/>
    <text x="${nx + aLab + 10}" y="${ny - bLab - 6}" fill="${Tx}" font-size="12.5" font-family="inherit">areola${el ? ' ' + el.a.toFixed(0) + '×' + el.b.toFixed(0) : ' Ø ' + areolaD.toFixed(0)} mm</text>`;
  };

  return `<svg viewBox="${-W} ${H0} ${W * 2} ${H1 - H0}" xmlns="http://www.w3.org/2000/svg"
     style="width:100%;height:auto;display:block;background:#0b0e14;border-radius:12px">
  <defs><marker id="ar" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
    <path d="M0,0 L8,4 L0,8 z" fill="${L}"/></marker></defs>

  <path d="${torsoPath}" fill="none" stroke="${D}" stroke-width="2"/>
  <g transform="scale(-1,1)"><path d="${torsoPath}" fill="none" stroke="${D}" stroke-width="2"/></g>
  <line x1="-42" y1="-215" x2="42" y2="-215" stroke="${D}" stroke-width="2"/>

  <line x1="0" y1="-160" x2="0" y2="0" stroke="${Faint}" stroke-width="1.4" stroke-dasharray="7 5"/>
  <text x="10" y="-150" fill="${Faint}" font-size="12" font-family="inherit">cleavage</text>

  <line x1="${-F}" y1="0" x2="${F}" y2="0" stroke="${D}" stroke-width="1.8"/>
  <text x="${-F}" y="20" fill="${Faint}" font-size="12" font-family="inherit">fold</text>

  ${side(1)}${side(-1)}

  ${dim(F + 34, 0, F + 34, ny, nipUp.toFixed(0) + ' mm', F + 34, ny / 2 - 8)}
  <text x="${F + 34}" y="${ny / 2 + 10}" fill="${Faint}" font-size="11" text-anchor="middle" font-family="inherit">nipple→fold</text>
  ${T.contourTable ? `<text x="${-W + 14}" y="${H0 + 90}" fill="${M}" font-size="12.5" font-family="inherit">green outline: measured breast contour (${Math.round(T.contourCoverage * 100)}% of footprint)</text>` : ''}
  ${T.areolaEllipse && T.areolaEllipse.tiltDeg !== null ? `<text x="${-W + 14}" y="${H0 + 110}" fill="${Faint}" font-size="12.5" font-family="inherit">areola tilt ~${T.areolaEllipse.tiltDeg.toFixed(0)}° from camera axis (diagnostic)</text>` : ''}

  <g font-family="inherit">
    <text x="${-W + 14}" y="${H0 + 28}" fill="${Tx}" font-size="20" font-weight="700">${T.cup}</text>
    <text x="${-W + 14}" y="${H0 + 50}" fill="${Faint}" font-size="12.5">breast_telemetry/v1 · ${T.source}</text>
    <text x="${-W + 14}" y="${H0 + 70}" fill="${Faint}" font-size="12.5">1 unit = 1 mm · origin at fold × cleavage · mirrored L/R</text>
  </g>
</svg>`;
}
