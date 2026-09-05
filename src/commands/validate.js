'use strict';
const fs = require('node:fs');
const { expandInputs } = require('../paths.js');
const { normalizeScene } = require('../normalize-scene.js');
async function run(argv) {
  let failed = false;
  for (const file of expandInputs(argv)) {
    try {
      const scene = normalizeScene(JSON.parse(fs.readFileSync(file, 'utf8')));
      console.log(scene.id + ': OK grids=' + JSON.stringify(scene.timeline.grids));
      scene.timeline.animations.forEach(a => console.log('  ' + a.kind + ' ' + JSON.stringify(Object.fromEntries(['cycles', 'travelMs', 'effectiveSpeedPxPerSec', 'effectivePeriodMs', 'holdMs', 'stepStartsMs'].filter(key => a[key] !== undefined).map(key => [key, a[key]])))));
      for (const warning of scene.warnings) console.log('  warning: ' + warning);
    } catch (e) { failed = true; console.error(file + ': FAIL\n' + e.message); }
  }
  if (failed) process.exitCode = 1;
  return { ok: !failed };
}
module.exports = { run };
