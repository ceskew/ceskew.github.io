// node tools/verify.js — every level must start unsolved, and its recorded solution must solve it
// and keep solving it when every piece is nudged (so no level depends on pixel-perfect placement).
const { scene, D, Optics, LEVELS } = require('./lib');
let fail = 0;
LEVELS.forEach((L, i) => {
  const sol = globalThis.SOLUTIONS[L.name], sc = scene(L), mov = sc.pieces.filter(p => p.lock !== 'all');
  const solved = () => Optics.evaluate(sc, Optics.build(sc)).every(r => r.ok);
  const start = solved();
  let ok = false, robust = 0, trials = 0, fills = '';
  if (sol) {
    const set = (j) => mov.forEach((p, k) => { p.x = sol[k][0] + j * (Math.random() - .5) * 2; p.y = sol[k][1] + j * (Math.random() - .5) * 2; p.a = (sol[k][2] + j * 0.15 * (Math.random() - .5) * 2) * D; });
    set(0); ok = solved(); fills = Optics.evaluate(sc, Optics.build(sc)).map(r => r.fill.toFixed(2)).join(' ');
    for (; trials < 200; trials++) { set(4); if (solved()) robust++; }
  }
  const pass = !start && ok && robust / trials > 0.6; if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${String(i + 1).padStart(2)} ${L.name.padEnd(30)} starts-unsolved:${!start} solution:${ok} fills:[${fills}] robust-under-nudge:${(100 * robust / trials).toFixed(0)}%`);
});
console.log(fail ? `${fail} level(s) FAILED` : `all ${LEVELS.length} levels verified`);
process.exit(fail ? 1 : 0);
