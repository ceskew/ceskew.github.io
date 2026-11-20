// Shared helpers for the Node tools: load the browser scripts and turn a level into a scene.
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = path.join(__dirname, '..');
for (const f of ['optics.js', 'levels.js']) vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
try { vm.runInThisContext(fs.readFileSync(path.join(dir, 'solutions.js'), 'utf8')); } catch (e) { globalThis.SOLUTIONS = {}; }
const D = Math.PI / 180;
function scene(L) {
  return {
    walls: L.walls,
    sensors: L.sens.map(s => ({ x: s[0], y: s[1], need: s[2] })),
    pieces: L.src.map(s => ({ t: 'source', x: s[0], y: s[1], a: s[2] * D, lock: 'all' }))
      .concat(L.pcs.map(p => Object.assign({}, p, { a: p.a * D })))
  };
}
module.exports = { scene, D, dir, Optics: globalThis.Optics, LEVELS: globalThis.LEVELS };
