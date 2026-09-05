'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { encode, chooseEncoder } = require('../encode/encode.js');
const { normalizeScene } = require('../normalize-scene.js');
async function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    frames: { type: 'string' }, duration: { type: 'string' }, step: { type: 'string', default: '40' }, encoder: { type: 'string', default: 'auto' },
    output: { type: 'string', short: 'o' }, scene: { type: 'string' }, width: { type: 'string', default: '800' }, rung: { type: 'string', default: '0' }, 'reserved-color': { type: 'string', multiple: true }
  } });
  const sceneFile = values.scene || positionals[0];
  const scene = sceneFile ? normalizeScene(JSON.parse(fs.readFileSync(sceneFile, 'utf8'))) : undefined;
  if (!values.frames || !values.output || (!scene && !values.duration)) throw new Error('Usage: encode --frames DIR --duration MS --step 40 --encoder pillow -o FILE [--scene FILE]');
  let selection;
  try { selection = await chooseEncoder(values.encoder); }
  catch (error) {
    if (values.encoder === 'gifski' && error.message === 'gifski unavailable') { console.log('SKIP: gifski unavailable (tools/bin/gifski.exe, TECH_GIFS_GIFSKI and PATH checked); use --encoder pillow.'); return { skipped: true }; }
    throw error;
  }
  const result = await encode({ scene, framesDir: path.resolve(values.frames), outPath: values.output, durationMs: values.duration ? Number(values.duration) : scene.timeline.durationMs,
    stepMs: Number(values.step), rung: Number(values.rung), width: Number(values.width), encoder: values.encoder, selection, reservedColors: values['reserved-color'] });
  fs.writeFileSync(result.gifPath + '.encode.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  return result;
}
module.exports = { run };
