'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolvePython, runProcess } = require('../python.js');
async function encode(options) {
  const python = await resolvePython();
  const outPath = path.resolve(options.outPath);
  const jobPath = options.jobPath || outPath + '.pillow-job.json';
  const job = { framePaths: options.framePaths, width: options.width || 800, delayMs: options.stepMs || options.delayMs || 40, paletteColors: options.paletteColors || 256,
    reservedColors: options.reservedColors || [], sampleCount: options.sampleCount || 8, outPath, paletteMethod: options.paletteMethod || 'mediancut' };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.mkdirSync(path.dirname(jobPath), { recursive: true });
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  const argv = [path.join(__dirname, 'pillow.py'), '--job', jobPath];
  const result = await runProcess(python.command, argv);
  const logPath = options.logPath || outPath + '.encode.log';
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({ python, argv }) + '\n' + result.stdout + result.stderr);
  if (result.code !== 0) throw new Error(`Pillow exit ${result.code}: ${result.stderr}`);
  const metrics = JSON.parse(result.stdout.trim());
  return { gifPath: outPath, encoder: 'pillow', bytes: fs.statSync(outPath).size, argv, paletteMethod: metrics.paletteMethod, metrics, python, jobPath, logPath };
}
module.exports = { encode };
