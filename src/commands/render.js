'use strict';

const { runBatch } = require('../batch.js');
const { capture } = require('../capture/capture-frames.js');
const { runLadder, resolveReservedColors } = require('../encode/encode.js');
const { verify } = require('../quality/quality-gate.js');
const path = require('node:path');

function realStages(options = {}) {
  const offline = options.offline ?? process.env.DIAGIF_OFFLINE === '1';
  return {
    capture,
    async encode(args) {
      console.log(args.scene.id + ': encoding and gating ladder');
      const result = await runLadder({ ...args, workDir: path.dirname(args.framesDir),
        encoder: offline ? 'pillow' : options.encoder,
        caps: options.caps, capture, launchArgs: options.launchArgs }, offline ? { discoverGifsicle: async () => null } : {});
      if (!result.primary) {
        const error = new Error('No passing primary: ' + result.ladder.map(a => a.failures.join('; ')).filter(Boolean).join(' | '));
        error.ladder = result.ladder;
        throw error;
      }
      return { ...result.primary, ladder: result.ladder, safeVariant: result.safeVariant };
    },
    verify
  };
}

// Stage injection remains available for isolated batch tests and callers.
async function run(argv, { stages, ...options } = {}) {
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node src/cli.js render <scene.json|glob>... [--max-parallel-scenes N] [--manifest path]');
      console.log('Capture -> encoder ladder -> quality gate -> GIFs, contact sheets and manifest.');
      return { exitCode: 0 };
    }
    if (arg === '--') { inputs.push(...argv.slice(i + 1)); break; }
    if (arg === '--max-parallel-scenes' || arg === '--manifest') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      if (arg === '--manifest') options.manifestPath = value;
      else {
        if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('--max-parallel-scenes must be a positive integer');
        options.maxParallelScenes = Number(value);
      }
    } else if (arg.startsWith('-')) throw new Error('Unknown render option: ' + arg);
    else inputs.push(arg);
  }
  const result = await runBatch(inputs, stages || realStages(options), {
    ...options, reservedColors: options.reservedColors || resolveReservedColors
  });
  for (const entry of result.manifest.scenes) {
    console.log((entry.id || entry.input) + ': ' + entry.status.toUpperCase() + (entry.error ? ' (' + entry.stage + ': ' + entry.error + ')' : ''));
  }
  console.log('Manifest: ' + result.manifestPath);
  process.exitCode = result.exitCode;
  return result;
}

module.exports = { run, realStages };
