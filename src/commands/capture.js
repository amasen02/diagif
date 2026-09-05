'use strict';
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { capture, readFixture } = require('../capture/capture-frames.js');
const { normalizeScene } = require('../normalize-scene.js');
const { expandInputs, scenePaths, absolute } = require('../paths.js');
function parse(argv, extra = {}) {
  return parseArgs({ args: argv, allowPositionals: true, options: {
    step: { type: 'string', default: '40' }, 'work-dir': { type: 'string' }, 'launch-arg': { type: 'string', multiple: true }, ...extra
  } });
}
function input(positionals, fixture) {
  if (fixture) {
    if (positionals.length) throw new Error('Use either a scene file or --fixture');
    return readFixture(fixture);
  }
  if (positionals.length !== 1) throw new Error('Exactly one scene file is required');
  return { scene: normalizeScene(JSON.parse(fs.readFileSync(expandInputs(positionals)[0], 'utf8'))) };
}
function options(values) {
  return { stepMs: Number(values.step), workDir: values['work-dir'], launchArgs: values['launch-arg'] };
}
async function run(argv) {
  const { values, positionals } = parse(argv);
  const files = expandInputs(positionals);
  if (values['work-dir'] && files.length !== 1) throw new Error('--work-dir requires one scene');
  const results = [];
  for (const file of files) {
    try {
      const scene = normalizeScene(JSON.parse(fs.readFileSync(file, 'utf8'))), workDir = values['work-dir'] || scenePaths(scene.id).workDir;
      const result = await capture(scene, { ...options(values), workDir });
      const manifestPath = absolute(workDir, 'capture-' + result.stepMs + '.json');
      fs.writeFileSync(manifestPath, JSON.stringify({ sceneId: scene.id, ...result }, null, 2) + '\n');
      console.log(JSON.stringify({ sceneId: scene.id, frameCount: result.framePaths.length, manifestPath, launchArgProbe: result.launchArgProbe })); results.push(result);
    } catch (error) { console.error(file + ': ' + error.message); process.exitCode = 1; results.push({ file, error: error.message }); }
  }
  return results;
}
module.exports = { run, parse, input, options };
