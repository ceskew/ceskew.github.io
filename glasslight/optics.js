/* Glasslight — optics core. Pure functions, shared by the game and the Node level verifier. */
(function (G) {
  'use strict';
  const TAU = Math.PI * 2, LMIN = 400, LMAX = 700, EPS = 1e-4;
  const SB = { r: [600, 700], g: [500, 570], b: [430, 490] };   // sensor bands (nm)
  const FB = { r: [590, 700], g: [495, 575], b: [400, 495] };   // filter pass bands
  const NEED = { r: 'r', g: 'g', b: 'b', w: 'rgb', y: 'rg', m: 'rb', c: 'gb' };
  const TH = 0.3, CONTAM = 0.15;
  const SENSOR_R = 28, BEAM_W = 12;
  const SIZE = { mirror: 58, split: 58, filter: 46, prism: 72, ball: 44, lensH: 78, lensR: 220 };

  // Cauchy dispersion, deliberately exaggerated ("very heavy flint") so spectra open up on a desk-sized bench.
  function nGlass(l) { const u = l * 1e-3; return 1.3997 + 0.0424 / (u * u); }

  // CIE 1931 colour matching (Wyman/Sloan/Shirley analytic fit) -> linear sRGB, normalised so the flat spectrum sums to white.
  const LUT = new Float32Array(301 * 3);
  (function () {
    const g = (l, m, s1, s2) => { const t = (l - m) / (l < m ? s1 : s2); return Math.exp(-0.5 * t * t); };
    const sum = [0, 0, 0];
    for (let i = 0; i <= 300; i++) {
      const l = 400 + i;
      const x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
      const y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
      const z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
      const c = [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.2040 * y + 1.0570 * z];
      for (let k = 0; k < 3; k++) { c[k] = Math.max(0, c[k]); LUT[i * 3 + k] = c[k]; sum[k] += c[k]; }
    }
    for (let i = 0; i <= 300; i++) for (let k = 0; k < 3; k++) LUT[i * 3 + k] *= 301 / sum[k];
  })();

  function addSeg(P, ax, ay, bx, by, type, extra) {
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    const p = { k: 0, ax, ay, dx, dy, nx: -dy / L, ny: dx / L, type, band: null, idx: -1 };
    if (extra) Object.assign(p, extra);
    P.push(p); return p;
  }
  function addArc(P, cx, cy, r, mid, half, type, extra) {
    const p = { k: 1, cx, cy, r, mid, half, type, band: null, idx: -1 };
    if (extra) Object.assign(p, extra);
    P.push(p); return p;
  }
  function prismVerts(pc) {
    const v = [];
    for (let i = 0; i < 3; i++) { const a = pc.a + Math.PI / 2 + i * TAU / 3; v.push([pc.x + Math.cos(a) * SIZE.prism, pc.y + Math.sin(a) * SIZE.prism]); }
    return v;
  }
  function lensGeom(pc) {
    const R = SIZE.lensR, h = SIZE.lensH, c = Math.sqrt(R * R - h * h), half = Math.asin(h / R);
    const ca = Math.cos(pc.a), sa = Math.sin(pc.a);
    return { R, half, c, arcs: [[pc.x - c * ca, pc.y - c * sa, pc.a], [pc.x + c * ca, pc.y + c * sa, pc.a + Math.PI]] };
  }

  // scene: {walls:[[x1,y1,x2,y2]], sensors:[{x,y,need}], pieces:[{t,x,y,a,band}]}
  function build(scene) {
    const P = [];
    for (const w of scene.walls) addSeg(P, w[0], w[1], w[2], w[3], 'wall');
    scene.sensors.forEach((s, i) => addArc(P, s.x, s.y, SENSOR_R, 0, Math.PI, 'sensor', { idx: i }));
    for (const pc of scene.pieces) {
      const ca = Math.cos(pc.a), sa = Math.sin(pc.a);
      if (pc.t === 'mirror' || pc.t === 'split' || pc.t === 'filter') {
        const L = SIZE[pc.t];
        addSeg(P, pc.x - ca * L, pc.y - sa * L, pc.x + ca * L, pc.y + sa * L, pc.t, { band: pc.band || null });
      } else if (pc.t === 'prism') {
        const v = prismVerts(pc);
        for (let i = 0; i < 3; i++) {
          const a = v[i], b = v[(i + 1) % 3];
          const s = addSeg(P, a[0], a[1], b[0], b[1], 'glass');
          if (s.nx * ((a[0] + b[0]) / 2 - pc.x) + s.ny * ((a[1] + b[1]) / 2 - pc.y) < 0) { s.nx = -s.nx; s.ny = -s.ny; }
        }
      } else if (pc.t === 'ball') {
        addArc(P, pc.x, pc.y, SIZE.ball, 0, Math.PI, 'glass');
      } else if (pc.t === 'lens') {
        const g = lensGeom(pc);
        for (const a of g.arcs) addArc(P, a[0], a[1], g.R, a[2], g.half, 'glass');
      }
    }
    return P;
  }

  // Trace one ray through the scene. Splits at half-mirrors and (Fresnel) at glass surfaces.
  // out: flat array receiving [x0,y0,x1,y1,lambda,weight] per segment. rec(idx, lambda, weight) on sensor hits.
  function trace(P, ox, oy, dx, dy, lam, w, out, rec, depth) {
    const ng = nGlass(lam), n = P.length;
    for (let bounce = 0; bounce < 40; bounce++) {
      let best = 1e9, hit = null, hnx = 0, hny = 0;
      for (let i = 0; i < n; i++) {
        const p = P[i];
        if (p.k === 0) {
          const den = dx * p.dy - dy * p.dx;
          if (den > -1e-12 && den < 1e-12) continue;
          const rx = p.ax - ox, ry = p.ay - oy;
          const t = (rx * p.dy - ry * p.dx) / den;
          if (t <= EPS || t >= best) continue;
          const u = (rx * dy - ry * dx) / den;
          if (u < 0 || u > 1) continue;
          best = t; hit = p; hnx = p.nx; hny = p.ny;
        } else {
          const fx = ox - p.cx, fy = oy - p.cy;
          const B = fx * dx + fy * dy, C = fx * fx + fy * fy - p.r * p.r, D = B * B - C;
          if (D < 0) continue;
          const s = Math.sqrt(D);
          for (let j = 0; j < 2; j++) {
            const t = j ? -B + s : -B - s;
            if (t <= EPS || t >= best) continue;
            const px = fx + t * dx, py = fy + t * dy;
            if (p.half < Math.PI) {
              let d = Math.atan2(py, px) - p.mid; d -= TAU * Math.round(d / TAU);
              if (d > p.half || d < -p.half) continue;
            }
            best = t; hit = p; hnx = px / p.r; hny = py / p.r;
          }
        }
      }
      if (!hit) { if (out) out.push(ox, oy, ox + dx * 4000, oy + dy * 4000, lam, w); return; }
      const hx = ox + dx * best, hy = oy + dy * best;
      if (out) out.push(ox, oy, hx, hy, lam, w);
      ox = hx; oy = hy;
      const type = hit.type;
      if (type === 'wall') return;
      if (type === 'sensor') { if (rec) rec(hit.idx, lam, w); return; }
      if (type === 'filter') { const f = FB[hit.band]; if (lam < f[0] || lam > f[1]) return; continue; }
      const dn = dx * hnx + dy * hny;
      if (type === 'mirror') { dx -= 2 * dn * hnx; dy -= 2 * dn * hny; w *= 0.98; continue; }
      if (type === 'split') {
        w *= 0.5;
        if (depth < 6) trace(P, ox, oy, dx - 2 * dn * hnx, dy - 2 * dn * hny, lam, w, out, rec, depth + 1);
        continue;
      }
      // glass: Snell + Fresnel
      let n1 = 1, n2 = ng, Nx = hnx, Ny = hny, ci = -dn;
      if (ci < 0) { n1 = ng; n2 = 1; Nx = -hnx; Ny = -hny; ci = dn; }
      const eta = n1 / n2, k = 1 - eta * eta * (1 - ci * ci);
      const rdx = dx + 2 * ci * Nx, rdy = dy + 2 * ci * Ny;
      if (k < 0) { dx = rdx; dy = rdy; continue; }            // total internal reflection
      const ct = Math.sqrt(k);
      const rs = (n1 * ci - n2 * ct) / (n1 * ci + n2 * ct), rp = (n1 * ct - n2 * ci) / (n1 * ct + n2 * ci);
      const R = 0.5 * (rs * rs + rp * rp);
      if (w * R > 0.012 && depth < 6) trace(P, ox, oy, rdx, rdy, lam, w * R, out, rec, depth + 1);
      w *= 1 - R;
      const f = eta * ci - ct;
      dx = eta * dx + f * Nx; dy = eta * dy + f * Ny;
      const L = Math.hypot(dx, dy); dx /= L; dy /= L;
    }
  }

  // Deterministic measurement of every sensor. Returns [{frac:{r,g,b}, fill, contam, ok}], optional out = ray segments.
  const NL = 60, OFFS = [-0.4, -0.2, 0, 0.2, 0.4];
  const EMIT = { r: 0, g: 0, b: 0 };
  for (let i = 0; i < NL; i++) { const l = 402.5 + i * 5; for (const b in SB) if (l >= SB[b][0] && l <= SB[b][1]) EMIT[b] += OFFS.length; }
  function evaluate(scene, P, out) {
    const acc = scene.sensors.map(() => ({ r: 0, g: 0, b: 0 }));
    const rec = (idx, lam, w) => { const a = acc[idx]; for (const b in SB) if (lam >= SB[b][0] && lam <= SB[b][1]) a[b] += w; };
    for (const pc of scene.pieces) {
      if (pc.t !== 'source') continue;
      const dx = Math.cos(pc.a), dy = Math.sin(pc.a);
      for (let i = 0; i < NL; i++) for (const o of OFFS)
        trace(P, pc.x - dy * o * BEAM_W, pc.y + dx * o * BEAM_W, dx, dy, 402.5 + i * 5, 1, out, rec, 0);
    }
    return scene.sensors.map((s, i) => {
      const need = NEED[s.need], frac = {}; let fill = 9, bad = 0;
      for (const b in SB) {
        frac[b] = acc[i][b] / EMIT[b];
        if (need.indexOf(b) >= 0) fill = Math.min(fill, frac[b] / TH); else bad = Math.max(bad, frac[b]);
      }
      const contam = bad > CONTAM;
      return { frac, fill, bad, contam, ok: fill >= 1 && !contam };
    });
  }

  G.Optics = { TAU, LMIN, LMAX, SB, FB, NEED, TH, CONTAM, SENSOR_R, BEAM_W, SIZE, LUT, nGlass, build, trace, evaluate, prismVerts, lensGeom };
})(typeof window !== 'undefined' ? window : globalThis);
