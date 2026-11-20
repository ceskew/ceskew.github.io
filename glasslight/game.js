/* Glasslight — game shell: rendering (WebGL2 HDR light accumulation + 2D overlay), input, audio, UI. */
(function () {
  'use strict';
  const O = window.Optics, LEVELS = window.LEVELS, SOL = window.SOLUTIONS || {};
  const D = Math.PI / 180, TAU = Math.PI * 2, BW = 1600, BH = 900;
  const $ = id => document.getElementById(id);
  const glc = $('gl'), uic = $('ui'), ctx = uic.getContext('2d');
  const gl = glc.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl) { $('nogl').style.display = 'grid'; $('title').classList.remove('show'); return; }

  const COL = { r: '#ff5b4a', g: '#58f08a', b: '#5aa0ff', w: '#ffffff', y: '#ffd84a', m: '#ff5ae0', c: '#4ae8ff' };
  const NOTE = { r: 220, w: 277.18, g: 329.63, y: 369.99, m: 415.3, b: 493.88, c: 554.37 };
  const HANDLE = { mirror: 100, split: 100, filter: 88, prism: 114, lens: 120, source: 74 };

  // ---------- state ----------
  const S = { scene: null, prims: [], res: [], idx: 0, sandbox: false, sel: null, hover: null, drag: null, solved: false, okSince: 0, dirty: true, lastChange: 0, tween: null, solvedAt: -1e9, shown: [] };
  let save = { done: {}, last: 0, mute: false };
  try { const s = JSON.parse(localStorage.getItem('glasslight.v1')); if (s && typeof s === 'object') save = Object.assign(save, s); } catch (e) { /* storage unavailable */ }
  const persist = () => { try { localStorage.setItem('glasslight.v1', JSON.stringify(save)); } catch (e) { /* ignore */ } };

  function makeScene(L) {
    return {
      walls: L.walls,
      sensors: L.sens.map(s => ({ x: s[0], y: s[1], need: s[2] })),
      pieces: L.src.map(s => ({ t: 'source', x: s[0], y: s[1], a: s[2] * D, lock: 'all' }))
        .concat(L.pcs.map(p => ({ t: p.t, x: p.x, y: p.y, a: p.a * D, band: p.band || null, lock: p.lock || '' })))
    };
  }
  const SANDBOX = { name: 'Sandbox', hint: 'No goals here. Add glass, cross the beams, chase the caustics.', src: [], walls: [], sens: [],
    pcs: [{ t: 'source', x: 150, y: 430, a: 0 }, { t: 'prism', x: 520, y: 452, a: 195 }, { t: 'ball', x: 800, y: 668, a: 0 }, { t: 'lens', x: 1130, y: 250, a: 30 }, { t: 'mirror', x: 1040, y: 830, a: 6 }] };

  function load(i, sandbox) {
    S.sandbox = !!sandbox; S.idx = i;
    const L = sandbox ? SANDBOX : LEVELS[i];
    S.scene = makeScene(L); S.sel = S.hover = S.drag = S.tween = null; S.solved = false; S.okSince = 0; S.dirty = true; S.shown = S.scene.sensors.map(() => 0);
    $('num').textContent = sandbox ? 'Free play' : `Experiment ${String(i + 1).padStart(2, '0')} / ${LEVELS.length}`;
    $('name').textContent = L.name; $('hint').textContent = L.hint;
    $('done').classList.remove('show'); $('tray').classList.toggle('show', S.sandbox);
    $('bSand').classList.toggle('on', S.sandbox); $('bReveal').style.display = sandbox ? 'none' : '';
    if (!sandbox) { save.last = i; persist(); }
    clearAccum = true;
  }
  const movers = () => S.scene.pieces.filter(p => p.lock !== 'all');
  function reveal() {
    if (S.sandbox) return;
    const sol = SOL[LEVELS[S.idx].name]; if (!sol) return;
    const mv = movers();
    S.tween = { t0: performance.now(), dur: 1500, items: mv.map((p, k) => { let da = sol[k][2] * D - p.a; da -= TAU * Math.round(da / TAU); return { p, x0: p.x, y0: p.y, a0: p.a, x1: sol[k][0], y1: sol[k][1], da }; }) };
    S.sel = null;
  }

  // ---------- view ----------
  let W = 1, H = 1, dpr = 1, vs = 1, vox = 0, voy = 0, clearAccum = true;
  const toWorld = (px, py) => [(px - vox) / vs, (py - voy) / vs];

  // ---------- WebGL ----------
  const hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  function prog(vsrc, fsrc) {
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, '#version 300 es\nprecision highp float;\n' + s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vsrc)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsrc)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u };
  }
  const FS_VS = 'out vec2 v; void main(){ vec2 p=vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2)); v=p; gl_Position=vec4(p*2.-1.,0.,1.); }';
  const pRay = prog('in vec2 a_pos; in float a_edge; in vec3 a_col; uniform vec4 u_view; out float e; out vec3 c; void main(){ e=a_edge; c=a_col; gl_Position=vec4(a_pos*u_view.xy+u_view.zw,0.,1.); }',
    'in float e; in vec3 c; out vec4 o; void main(){ o=vec4(c*exp(-e*e*4.5),1.); }');
  const pFade = prog(FS_VS, 'uniform float u_a; out vec4 o; void main(){ o=vec4(0.,0.,0.,u_a); }');
  const pBlur = prog(FS_VS, 'in vec2 v; uniform sampler2D t; uniform vec2 d; out vec4 o; void main(){ vec3 c=texture(t,v).rgb*.227; c+=(texture(t,v+d).rgb+texture(t,v-d).rgb)*.1946; c+=(texture(t,v+2.*d).rgb+texture(t,v-2.*d).rgb)*.1216; c+=(texture(t,v+3.*d).rgb+texture(t,v-3.*d).rgb)*.0541; c+=(texture(t,v+4.*d).rgb+texture(t,v-4.*d).rgb)*.0162; o=vec4(c,1.); }');
  const pComp = prog(FS_VS, `in vec2 v; uniform sampler2D A,B1,B2; uniform vec2 res; uniform vec3 view; out vec4 o;
    float h(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec3 c=texture(A,v).rgb+.26*texture(B1,v).rgb+.2*texture(B2,v).rgb;
      c=1.-exp(-c*1.5); c=pow(c,vec3(.4545));
      vec2 px=vec2(v.x*res.x,(1.-v.y)*res.y), w=(px-view.yz)/view.x;
      vec2 g=(fract(w/50.+.5)-.5)*50.;
      float inb=step(0.,w.x)*step(w.x,1600.)*step(0.,w.y)*step(w.y,900.);
      float dots=smoothstep(1.9,.7,length(g))*inb;
      float vig=smoothstep(1.05,.2,length(v-.5));
      vec3 bg=(vec3(.016,.021,.04)+vec3(.05,.065,.11)*dots)*mix(.35,1.,vig);
      o=vec4(bg+c+(h(px)-.5)/255.,1.);
    }`);
  const rayVAO = gl.createVertexArray(), rayBuf = gl.createBuffer(), emptyVAO = gl.createVertexArray();
  const MAXSEG = 24000, verts = new Float32Array(MAXSEG * 36);
  gl.bindVertexArray(rayVAO); gl.bindBuffer(gl.ARRAY_BUFFER, rayBuf); gl.bufferData(gl.ARRAY_BUFFER, verts.byteLength, gl.DYNAMIC_DRAW);
  [['a_pos', 2, 0], ['a_edge', 1, 8], ['a_col', 3, 12]].forEach(([n, s, off]) => { const l = gl.getAttribLocation(pRay.p, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, s, gl.FLOAT, false, 24, off); });
  gl.bindVertexArray(null);
  function target(w, h) {
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }
  let T = null;
  function resize() {
    W = window.innerWidth; H = window.innerHeight; dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.max(2, Math.round(W * dpr)), ph = Math.max(2, Math.round(H * dpr));
    for (const c of [glc, uic]) { c.width = pw; c.height = ph; }
    const top = W < 700 ? 96 : 0;                               // leave room for the heading on narrow screens
    vs = Math.min(W / BW, (H - top) / BH) * 0.985; vox = (W - BW * vs) / 2; voy = top + (H - top - BH * vs) / 2;
    if (T) for (const k in T) { gl.deleteTexture(T[k].tex); gl.deleteFramebuffer(T[k].fb); }
    const q = (d) => [Math.max(2, pw >> d), Math.max(2, ph >> d)];
    T = { acc: target(pw, ph), a1: target(...q(2)), b1: target(...q(2)), a2: target(...q(4)), b2: target(...q(4)) };
    clearAccum = true;
  }
  window.addEventListener('resize', resize); resize();

  const segs = [];
  let rayCount = 1100, slow = 0;
  function drawLight(now) {
    const moving = now - S.lastChange < 140;
    const decay = hdr ? (moving ? 0.7 : 0.9) : 0;
    // trace this frame's jittered rays
    segs.length = 0;
    const srcs = S.scene.pieces.filter(p => p.t === 'source');
    const per = Math.max(60, (rayCount / Math.max(1, srcs.length)) | 0);
    for (const s of srcs) {
      const dx = Math.cos(s.a), dy = Math.sin(s.a);
      for (let i = 0; i < per; i++) {
        const lam = 400 + 300 * (i + Math.random()) / per, o = (Math.random() + Math.random() - 1) * 0.5 * O.BEAM_W;
        O.trace(S.prims, s.x - dy * o, s.y + dx * o, dx, dy, lam, 1, segs, null, 0);
      }
    }
    const ns = Math.min(MAXSEG, segs.length / 6), hw = 2.1 / vs, k = 7.5 * (1 - decay) / per * Math.sqrt(vs), LUT = O.LUT;
    let j = 0;
    for (let i = 0; i < ns; i++) {
      const b = i * 6, x0 = segs[b], y0 = segs[b + 1], x1 = segs[b + 2], y1 = segs[b + 3];
      let ex = x1 - x0, ey = y1 - y0; const l = Math.hypot(ex, ey) || 1; ex = ex / l * hw; ey = ey / l * hw;
      const li = Math.max(0, Math.min(300, Math.round(segs[b + 4] - 400))) * 3, w = segs[b + 5] * k;
      const r = LUT[li] * w, g = LUT[li + 1] * w, bl = LUT[li + 2] * w;
      const ax = x0 + ey, ay = y0 - ex, bx = x0 - ey, by = y0 + ex, cx = x1 + ey, cy = y1 - ex, dx2 = x1 - ey, dy2 = y1 + ex;
      verts[j++] = ax; verts[j++] = ay; verts[j++] = -1; verts[j++] = r; verts[j++] = g; verts[j++] = bl;
      verts[j++] = bx; verts[j++] = by; verts[j++] = 1; verts[j++] = r; verts[j++] = g; verts[j++] = bl;
      verts[j++] = cx; verts[j++] = cy; verts[j++] = -1; verts[j++] = r; verts[j++] = g; verts[j++] = bl;
      verts[j++] = bx; verts[j++] = by; verts[j++] = 1; verts[j++] = r; verts[j++] = g; verts[j++] = bl;
      verts[j++] = dx2; verts[j++] = dy2; verts[j++] = 1; verts[j++] = r; verts[j++] = g; verts[j++] = bl;
      verts[j++] = cx; verts[j++] = cy; verts[j++] = -1; verts[j++] = r; verts[j++] = g; verts[j++] = bl;
    }
    // accumulate
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.acc.fb); gl.viewport(0, 0, T.acc.w, T.acc.h);
    gl.enable(gl.BLEND);
    if (clearAccum || decay === 0) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); clearAccum = false; }
    else { gl.useProgram(pFade.p); gl.uniform1f(pFade.u.u_a, decay); gl.blendFunc(gl.ZERO, gl.SRC_ALPHA); gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    gl.useProgram(pRay.p); gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform4f(pRay.u.u_view, 2 * vs / W, -2 * vs / H, 2 * vox / W - 1, 1 - 2 * voy / H);
    gl.bindVertexArray(rayVAO); gl.bindBuffer(gl.ARRAY_BUFFER, rayBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts, 0, j);
    gl.drawArrays(gl.TRIANGLES, 0, j / 6);
    gl.disable(gl.BLEND); gl.bindVertexArray(emptyVAO);
    // bloom
    const blur = (src, dst, dx, dy) => { gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fb : null); gl.viewport(0, 0, dst.w, dst.h); gl.useProgram(pBlur.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex); gl.uniform1i(pBlur.u.t, 0); gl.uniform2f(pBlur.u.d, dx, dy); gl.drawArrays(gl.TRIANGLES, 0, 3); };
    blur(T.acc, T.a1, 1.6 / T.acc.w, 0); blur(T.a1, T.b1, 0, 1.3 / T.a1.h); blur(T.b1, T.a1, 1.3 / T.a1.w, 0);
    blur(T.a1, T.a2, 1.5 / T.a1.w, 0); blur(T.a2, T.b2, 0, 1.4 / T.a2.h); blur(T.b2, T.a2, 1.4 / T.a2.w, 0);
    // composite
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, glc.width, glc.height); gl.useProgram(pComp.p);
    [[T.acc, 'A'], [T.a1, 'B1'], [T.a2, 'B2']].forEach(([t, n], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t.tex); gl.uniform1i(pComp.u[n], i); });
    gl.uniform2f(pComp.u.res, glc.width, glc.height); gl.uniform3f(pComp.u.view, vs * dpr, vox * dpr, voy * dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---------- overlay ----------
  function piecePath(p) {
    ctx.beginPath();
    if (p.t === 'prism') { const v = O.prismVerts(p); ctx.moveTo(v[0][0], v[0][1]); ctx.lineTo(v[1][0], v[1][1]); ctx.lineTo(v[2][0], v[2][1]); ctx.closePath(); }
    else if (p.t === 'ball') ctx.arc(p.x, p.y, O.SIZE.ball, 0, TAU);
    else if (p.t === 'lens') { const g = O.lensGeom(p); ctx.arc(g.arcs[0][0], g.arcs[0][1], g.R, p.a - g.half, p.a + g.half); ctx.arc(g.arcs[1][0], g.arcs[1][1], g.R, p.a + Math.PI - g.half, p.a + Math.PI + g.half); ctx.closePath(); }
    else { const L = O.SIZE[p.t], c = Math.cos(p.a) * L, s = Math.sin(p.a) * L; ctx.moveTo(p.x - c, p.y - s); ctx.lineTo(p.x + c, p.y + s); }
  }
  function handlePos(p) { const a = p.a + (p.t === 'lens' ? Math.PI / 2 : 0), r = HANDLE[p.t]; return [p.x + Math.cos(a) * r, p.y + Math.sin(a) * r]; }
  const canRot = p => p.lock !== 'all' && p.t !== 'ball';
  const canMove = p => p.lock === '';

  function drawPiece(p, now) {
    const hot = p === S.sel || p === S.hover, fixed = p.lock === 'all';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
    if (p.t === 'source') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.fillStyle = '#121a2b'; ctx.strokeStyle = hot ? '#dfe8fb' : '#7d8fb3'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(-58, -17, 50, 34, 6); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-8, -11); ctx.lineTo(2, -8); ctx.lineTo(2, 8); ctx.lineTo(-8, 11); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.75 + 0.2 * Math.sin(now / 400)})`; ctx.beginPath(); ctx.arc(-44, 0, 3, 0, TAU); ctx.fill();
      ctx.restore(); return;
    }
    piecePath(p);
    if (p.t === 'mirror') {
      ctx.strokeStyle = hot ? '#ffffff' : '#aebbd2'; ctx.lineWidth = 6; ctx.stroke();
      ctx.strokeStyle = 'rgba(20,28,48,.9)'; ctx.lineWidth = 2; ctx.stroke();
    } else if (p.t === 'split') {
      ctx.strokeStyle = hot ? 'rgba(220,240,255,.95)' : 'rgba(170,215,255,.7)'; ctx.lineWidth = 5; ctx.setLineDash([10, 9]); ctx.stroke(); ctx.setLineDash([]);
      ctx.lineWidth = 1.2; ctx.stroke();
    } else if (p.t === 'filter') {
      ctx.strokeStyle = COL[p.band]; ctx.globalAlpha = hot ? 1 : 0.8; ctx.lineWidth = 7; ctx.shadowColor = COL[p.band]; ctx.shadowBlur = 14 * vs * dpr; ctx.stroke(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = hot ? 'rgba(170,205,255,.12)' : 'rgba(150,190,255,.065)'; ctx.fill();
      ctx.strokeStyle = hot ? 'rgba(225,238,255,.95)' : 'rgba(180,210,255,.55)'; ctx.lineWidth = 1.6; ctx.stroke();
    }
    if (fixed || p.lock === 'pos') {                      // bolt: this piece is fastened to the bench
      ctx.fillStyle = '#04060c'; ctx.strokeStyle = 'rgba(190,210,245,.8)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, TAU); ctx.fill(); ctx.stroke();
      if (fixed) { ctx.beginPath(); ctx.moveTo(p.x - 2.6, p.y - 2.6); ctx.lineTo(p.x + 2.6, p.y + 2.6); ctx.stroke(); }
    }
  }
  function drawUI(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, uic.width, uic.height);
    ctx.setTransform(dpr * vs, 0, 0, dpr * vs, dpr * vox, dpr * voy);
    ctx.strokeStyle = 'rgba(140,165,215,.13)'; ctx.lineWidth = 1 / vs; ctx.setLineDash([]); ctx.beginPath(); ctx.roundRect(0, 0, BW, BH, 14); ctx.stroke();
    // walls
    ctx.lineCap = 'butt';
    for (const w of S.scene.walls) {
      ctx.strokeStyle = '#1b2233'; ctx.lineWidth = 12; ctx.beginPath(); ctx.moveTo(w[0], w[1]); ctx.lineTo(w[2], w[3]); ctx.stroke();
      ctx.strokeStyle = 'rgba(130,150,190,.55)'; ctx.lineWidth = 1.2; ctx.stroke();
    }
    // sensors
    S.scene.sensors.forEach((s, i) => {
      const r = S.res[i] || { fill: 0, contam: false, ok: false }, col = COL[s.need], R = O.SENSOR_R;
      S.shown[i] += (Math.min(1, r.fill) - S.shown[i]) * 0.2;
      const pulse = r.ok ? 0.5 + 0.5 * Math.sin(now / 260 + i) : 0;
      const since = (now - S.solvedAt) / 1000;
      if (S.solved && since < 1.6) { ctx.strokeStyle = col; ctx.globalAlpha = (1 - since / 1.6) * 0.7; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s.x, s.y, R + since * 150, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; }
      ctx.fillStyle = 'rgba(4,6,12,.9)'; ctx.beginPath(); ctx.arc(s.x, s.y, R, 0, TAU); ctx.fill();
      if (r.ok) { const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, R); g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)'); ctx.globalAlpha = 0.75 + 0.25 * pulse; ctx.fillStyle = g; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col; ctx.globalAlpha = 0.3; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(s.x, s.y, R - 4, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
      if (S.shown[i] > 0.01) { ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(s.x, s.y, R - 4, -Math.PI / 2, -Math.PI / 2 + TAU * S.shown[i]); ctx.stroke(); ctx.lineCap = 'butt'; }
      ctx.fillStyle = r.ok ? '#04060c' : col; ctx.font = '700 15px -apple-system,"Segoe UI",Roboto,Arial,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(s.need.toUpperCase(), s.x, s.y + 1);
      if (r.contam) {                                         // wrong colours arriving
        ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.setLineDash([5, 6]); ctx.lineDashOffset = -now / 60;
        ctx.beginPath(); ctx.arc(s.x, s.y, R + 7, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      }
    });
    for (const p of S.scene.pieces) drawPiece(p, now);
    const p = S.sel;
    if (p && canRot(p)) {
      const [hx, hy] = handlePos(p), rot = S.drag && S.drag.kind === 'rot';
      ctx.strokeStyle = 'rgba(200,220,255,.22)'; ctx.lineWidth = 1; ctx.setLineDash([3, 7]); ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE[p.t], 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = rot ? '#ffffff' : '#dfe8fb'; ctx.strokeStyle = '#04060c'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(hx, hy, rot ? 11 : 9, 0, TAU); ctx.fill(); ctx.stroke();
    }
  }

  // ---------- input ----------
  function hit(wx, wy, slop) {
    const ps = S.scene.pieces; let best = null, bd = 1e9;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]; if (p.lock === 'all') continue;
      const dx = wx - p.x, dy = wy - p.y, c = Math.cos(p.a), s = Math.sin(p.a), lx = dx * c + dy * s, ly = -dx * s + dy * c;
      let d;
      if (p.t === 'prism') d = Math.hypot(dx, dy) - 52;
      else if (p.t === 'ball') d = Math.hypot(dx, dy) - O.SIZE.ball;
      else if (p.t === 'lens') d = Math.max(Math.abs(lx) - 20, Math.abs(ly) - O.SIZE.lensH);
      else if (p.t === 'source') d = Math.max(Math.abs(lx + 30) - 30, Math.abs(ly) - 18);
      else d = Math.max(Math.abs(lx) - O.SIZE[p.t], Math.abs(ly) - 4);
      if (d < slop && d < bd) { bd = d; best = p; }
    }
    return best;
  }
  const touched = () => { S.dirty = true; };
  function pointer(e) { const r = uic.getBoundingClientRect(); return toWorld(e.clientX - r.left, e.clientY - r.top); }
  uic.addEventListener('pointerdown', e => {
    if (S.tween) return;
    audioInit();
    const [wx, wy] = pointer(e), slop = (e.pointerType === 'touch' ? 30 : 14) / Math.min(1, vs);
    if (S.sel && canRot(S.sel)) { const [hx, hy] = handlePos(S.sel); if (Math.hypot(wx - hx, wy - hy) < slop + 12) { S.drag = { kind: 'rot', p: S.sel, off: S.sel.a - Math.atan2(wy - S.sel.y, wx - S.sel.x) }; uic.setPointerCapture(e.pointerId); return; } }
    const p = hit(wx, wy, slop);
    if (p !== S.sel && p) blip(880, 0.03);
    S.sel = p;
    if (p && canMove(p)) { S.drag = { kind: 'move', p, dx: p.x - wx, dy: p.y - wy }; const ps = S.scene.pieces; ps.splice(ps.indexOf(p), 1); ps.push(p); }
    if (p) uic.setPointerCapture(e.pointerId);
  });
  uic.addEventListener('pointermove', e => {
    const [wx, wy] = pointer(e), d = S.drag;
    if (!d) { S.hover = e.pointerType === 'touch' ? null : hit(wx, wy, 14 / Math.min(1, vs)); let cur = S.hover ? (canMove(S.hover) ? 'grab' : 'pointer') : ''; if (S.sel && canRot(S.sel)) { const [hx, hy] = handlePos(S.sel); if (Math.hypot(wx - hx, wy - hy) < 22) cur = 'crosshair'; } uic.style.cursor = cur; return; }
    if (d.kind === 'move') { d.p.x = Math.max(30, Math.min(BW - 30, wx + d.dx)); d.p.y = Math.max(30, Math.min(BH - 30, wy + d.dy)); uic.style.cursor = 'grabbing'; }
    else { const pa = Math.atan2(wy - d.p.y, wx - d.p.x); let da = pa + d.off - d.p.a; da -= TAU * Math.round(da / TAU); d.p.a += e.shiftKey ? da * 0.15 : da; d.off = d.p.a - pa; }
    touched();
  });
  const up = () => { S.drag = null; };
  uic.addEventListener('pointerup', up); uic.addEventListener('pointercancel', up);
  uic.addEventListener('wheel', e => {
    e.preventDefault(); const p = S.hover || S.sel; if (!p || !canRot(p) || S.tween) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    p.a += Math.max(-120, Math.min(120, dy)) * 0.0004 * (e.shiftKey ? 0.15 : 1); S.sel = p; touched();
  }, { passive: false });
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase(), p = S.sel || S.hover, fine = e.shiftKey ? 0.12 : 1;
    if (k === 'escape') { if (document.querySelector('#menu.show')) $('menu').classList.remove('show'); else S.sel = null; return; }
    if (document.querySelector('.veil.show')) return;
    if (k === 'r') { load(S.idx, S.sandbox); return; }
    if (k === 'n' && S.solved) { $('bNext').click(); return; }
    if (!p || S.tween) return;
    if ((k === 'q' || k === 'e') && canRot(p)) { p.a += (k === 'q' ? -1 : 1) * 1.5 * D * fine; S.sel = p; touched(); }
    else if (k.startsWith('arrow') && canMove(p)) { const st = 4 * fine; p.x = Math.max(30, Math.min(BW - 30, p.x + (k === 'arrowleft' ? -st : k === 'arrowright' ? st : 0))); p.y = Math.max(30, Math.min(BH - 30, p.y + (k === 'arrowup' ? -st : k === 'arrowdown' ? st : 0))); S.sel = p; touched(); e.preventDefault(); }
    else if ((k === 'delete' || k === 'backspace') && S.sandbox) $('bDel').click();
  });

  // ---------- audio ----------
  const A = { ac: null, master: null, bus: null, voices: {} };
  function audioInit() {
    if (A.ac) { if (A.ac.state === 'suspended') A.ac.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    const ac = A.ac = new C();
    A.master = ac.createGain(); A.master.gain.value = save.mute ? 0 : 0.6; A.master.connect(ac.destination);
    const len = ac.sampleRate * 3.2, ir = ac.createBuffer(2, len, ac.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    const conv = ac.createConvolver(); conv.buffer = ir; const wet = ac.createGain(); wet.gain.value = 0.55; conv.connect(wet); wet.connect(A.master);
    A.bus = ac.createGain(); A.bus.connect(A.master); A.bus.connect(conv);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260; const dg = ac.createGain(); dg.gain.value = 0.11; lp.connect(dg); dg.connect(A.bus);
    for (const f of [55, 55.4, 82.5, 110.3]) { const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f; o.connect(lp); o.start(); }
    for (const n in NOTE) {
      const g = ac.createGain(); g.gain.value = 0; g.connect(A.bus);
      const o1 = ac.createOscillator(); o1.frequency.value = NOTE[n]; o1.connect(g);
      const o2 = ac.createOscillator(); o2.frequency.value = NOTE[n] * 2.004; const g2 = ac.createGain(); g2.gain.value = 0.22; o2.connect(g2); g2.connect(g);
      o1.start(); o2.start(); A.voices[n] = { g, o1 };
    }
  }
  function blip(f, vol, when, dur) {
    if (!A.ac) return; const ac = A.ac, t = ac.currentTime + (when || 0), o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
    o.connect(g); g.connect(A.bus); o.start(t); o.stop(t + (dur || 0.12) + 0.05);
  }
  function audioUpdate() {
    if (!A.ac) return; const lvl = {}, bad = {};
    S.scene.sensors.forEach((s, i) => { const r = S.res[i]; if (!r) return; lvl[s.need] = Math.max(lvl[s.need] || 0, Math.min(1, r.fill)); if (r.contam) bad[s.need] = true; });
    for (const n in A.voices) { const v = A.voices[n], t = A.ac.currentTime; v.g.gain.setTargetAtTime(0.085 * (lvl[n] || 0) * (bad[n] ? 0.5 : 1), t, 0.12); v.o1.detune.setTargetAtTime(bad[n] ? 45 : 0, t, 0.1); }
  }
  const chime = () => [440, 554.37, 659.25, 880, 1108.73, 1318.5].forEach((f, i) => blip(f, 0.11, i * 0.085, 1.4));

  // ---------- UI ----------
  function buildGrid() {
    const g = $('grid'); g.textContent = '';
    LEVELS.forEach((L, i) => {
      const b = document.createElement('button'), top = document.createElement('i'), n = document.createElement('span'), ok = document.createElement('span'), nm = document.createElement('b');
      n.textContent = String(i + 1).padStart(2, '0'); ok.textContent = save.done[L.name] ? '✓' : ''; ok.className = 'ok'; top.append(n, ok); nm.textContent = L.name; b.append(top, nm);
      if (i === S.idx && !S.sandbox) b.className = 'cur';
      b.onclick = () => { $('menu').classList.remove('show'); load(i, false); };
      g.append(b);
    });
  }
  $('bLevels').onclick = () => { buildGrid(); $('menu').classList.add('show'); };
  $('bClose').onclick = () => $('menu').classList.remove('show');
  $('menu').addEventListener('click', e => { if (e.target === $('menu')) $('menu').classList.remove('show'); });
  $('bReset').onclick = () => load(S.idx, S.sandbox);
  $('bReveal').onclick = reveal;
  const sandToggle = () => { $('menu').classList.remove('show'); if (S.sandbox) load(save.last, false); else load(0, true); };
  $('bSand').onclick = sandToggle; $('bMenuSand').onclick = sandToggle;
  const soundBtn = () => { $('bSound').textContent = save.mute ? 'Muted' : 'Sound'; $('bSound').setAttribute('aria-pressed', String(!save.mute)); };
  $('bSound').onclick = () => { audioInit(); save.mute = !save.mute; persist(); soundBtn(); if (A.ac) A.master.gain.setTargetAtTime(save.mute ? 0 : 0.6, A.ac.currentTime, 0.05); };
  soundBtn();
  $('bNext').onclick = () => { if (S.idx + 1 < LEVELS.length) load(S.idx + 1, false); else load(0, true); };
  $('begin').onclick = () => { audioInit(); $('title').classList.remove('show'); };
  $('tray').addEventListener('click', e => {
    const t = e.target.closest('button'); if (!t || !S.sandbox) return;
    if (t.id === 'bDel') { if (S.sel) { S.scene.pieces.splice(S.scene.pieces.indexOf(S.sel), 1); S.sel = S.hover = null; touched(); } return; }
    if (S.scene.pieces.length >= 28) return;
    const p = { t: t.dataset.add, band: t.dataset.band || null, x: 700 + Math.random() * 200, y: 380 + Math.random() * 140, a: t.dataset.add === 'source' ? 0 : (Math.random() - 0.5), lock: '' };
    S.scene.pieces.push(p); S.sel = p; touched(); blip(660, 0.04);
  });

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = now - last; last = now;
    if (dt > 34 && dt < 400) { if (++slow > 20 && rayCount > 350) { rayCount = Math.round(rayCount * 0.8); slow = 0; } } else if (slow > 0) slow--;
    if (S.tween) {
      const tw = S.tween; let u = Math.min(1, (now - tw.t0) / tw.dur); const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      for (const it of tw.items) { it.p.x = it.x0 + (it.x1 - it.x0) * e; it.p.y = it.y0 + (it.y1 - it.y0) * e; it.p.a = it.a0 + it.da * e; }
      if (u >= 1) S.tween = null; S.dirty = true;
    }
    if (S.dirty) { S.prims = O.build(S.scene); S.res = O.evaluate(S.scene, S.prims); S.dirty = false; S.lastChange = now; audioUpdate(); }
    const allOk = S.res.length > 0 && S.res.every(r => r.ok);
    if (!allOk || S.drag || S.tween) S.okSince = 0; else if (!S.okSince) S.okSince = now;
    if (!S.solved && S.okSince && now - S.okSince > 450 && !S.sandbox) {
      S.solved = true; S.solvedAt = now; save.done[LEVELS[S.idx].name] = 1; persist(); chime();
      const lastOne = S.idx + 1 >= LEVELS.length;
      $('doneMsg').textContent = lastOne ? 'Every experiment complete. The bench is yours.' : ['Aligned.', 'Resolved.', 'In focus.', 'Clean signal.'][S.idx % 4];
      $('bNext').textContent = lastOne ? 'Sandbox' : 'Next';
      $('done').classList.add('show');
    }
    if (S.solved && !allOk && !S.drag) { /* stays solved once achieved */ }
    drawLight(now); drawUI(now);
  }
  load(Math.min(save.last | 0, LEVELS.length - 1) || 0, false);
  requestAnimationFrame(frame);
  window.__glasslight = { S, load, reveal, LEVELS, view: () => ({ vs, vox, voy, hdr, rayCount }) };
})();
