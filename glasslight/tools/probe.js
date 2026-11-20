// node tools/probe.js <levelIndex> [x y aDeg ...]  — print where each wavelength's central ray ends up.
const { scene, D, Optics, LEVELS } = require('./lib');
const L = LEVELS[+process.argv[2]], sc = scene(L), args = process.argv.slice(3).map(Number);
const mov = sc.pieces.filter(p => p.t !== 'source' && p.lock !== 'all');
for (let i = 0; i * 3 < args.length; i++) { mov[i].x = args[i * 3]; mov[i].y = args[i * 3 + 1]; mov[i].a = args[i * 3 + 2] * D; }
const P = Optics.build(sc), s = sc.pieces[0];
for (const lam of [420, 460, 495, 535, 585, 650, 690]) {
  const out = []; Optics.trace(P, s.x, s.y, Math.cos(s.a), Math.sin(s.a), lam, 1, out, null, 9); // depth 9: main path only
  const n = out.length - 6, dx = out[n + 2] - out[n], dy = out[n + 3] - out[n + 1], l = Math.hypot(dx, dy);
  console.log(lam, 'segs', out.length / 6, 'from', out[n].toFixed(1), out[n + 1].toFixed(1), 'dir', (Math.atan2(dy, dx) / D).toFixed(2),
    [300, 500, 720, 1050].map(t => `@${t}:(${(out[n] + dx / l * t).toFixed(0)},${(out[n + 1] + dy / l * t).toFixed(0)})`).join(' '));
}
console.log(JSON.stringify(Optics.evaluate(sc, P).map(r => [+r.fill.toFixed(2), r.contam])));
