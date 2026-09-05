'use strict';
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { verify } = require('../quality/quality-gate.js');
const { normalizeScene } = require('../normalize-scene.js');
const { resolveReservedColors } = require('../encode/encode.js');
async function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    frames: { type: 'string' }, duration: { type: 'string' }, step: { type: 'string', default: '40' }, width: { type: 'string', default: '800' }, height: { type: 'string' },
    'max-bytes': { type: 'string', default: '5000000' }, encoder: { type: 'string' }, scene: { type: 'string' }, lossy: { type: 'boolean', default: false },
    'strict-frame-count': { type: 'boolean', default: false }, 'reserved-color': { type: 'string', multiple: true }, 'quality-json': { type: 'string' }
  } });
  const scene = values.scene ? normalizeScene(JSON.parse(fs.readFileSync(values.scene, 'utf8'))) : undefined;
  if (!positionals[0] || !values.frames || (!scene && (!values.duration || !values.height))) throw new Error('Usage: verify FILE --frames DIR --duration MS --height PX [--width 800 --step 40 --encoder pillow]');
  let metadata = {};
  if (fs.existsSync(positionals[0] + '.encode.json')) metadata = JSON.parse(fs.readFileSync(positionals[0] + '.encode.json', 'utf8'));
  const width = Number(values.width);
  const result = await verify({ gifPath: positionals[0], framesDir: values.frames, expectedWidth: width, expectedHeight: values.height ? Number(values.height) : Math.round(scene.canvas.height * width / 800),
    expectedDurationMs: values.duration ? Number(values.duration) : scene.timeline.durationMs, stepMs: Number(values.step), maxBytes: Number(values['max-bytes']),
    strictFrameCount: values['strict-frame-count'] || scene?.timeline?.strictFrameCount || false, reservedColors: values['reserved-color'] || (scene ? resolveReservedColors(scene) : metadata.reservedColors || []),
    lossy: values.lossy, encoder: values.encoder || metadata.encoder || 'gifski', qualityPath: values['quality-json'] });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
  return result;
}
module.exports = { run };
