'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { resolvePython, runProcess } = require('../python.js');
function assertDelays(delays, expectedDurationMs, stepMs, strictFrameCount = false) {
  if (!Number.isInteger(stepMs) || stepMs <= 0 || !Number.isInteger(expectedDurationMs) || expectedDurationMs <= 0 || expectedDurationMs % stepMs) throw new Error('duration must be a positive multiple of stepMs');
  if (!delays.length || delays.length > expectedDurationMs / stepMs || delays.length > 250) throw new Error('frame count outside expected range');
  if (delays.some(d => !Number.isInteger(d) || d <= 0 || d % stepMs)) throw new Error('delays must be positive multiples of stepMs');
  if (delays.reduce((a, b) => a + b, 0) !== expectedDurationMs) throw new Error('delay sum does not equal duration');
  if (strictFrameCount && delays.length !== expectedDurationMs / stepMs) throw new Error('strictFrameCount forbids merging');
  return true;
}
async function verify(options) {
  for (const key of ['expectedWidth', 'expectedHeight', 'expectedDurationMs', 'stepMs', 'maxBytes']) {
    if (!Number.isInteger(options[key]) || options[key] <= 0) return { ok: false, failures: [key + ' must be a positive integer'], warnings: [], metrics: {} };
  }
  const gifPath = path.resolve(options.gifPath);
  const qualityPath = path.resolve(options.qualityPath || gifPath + '.quality.json');
  const jobPath = qualityPath + '.job.json';
  const job = { ...options, gifPath, framesDir: path.resolve(options.framesDir), qualityPath };
  fs.mkdirSync(path.dirname(qualityPath), { recursive: true });
  // Never mistake a previous run's report for this invocation's evidence.
  if (fs.existsSync(qualityPath)) fs.unlinkSync(qualityPath);
  fs.writeFileSync(jobPath, JSON.stringify(job, null, 2));
  try {
    const python = await resolvePython();
    const result = await runProcess(python.command, [path.join(__dirname, 'verify.py'), '--job', jobPath]);
    if (!fs.existsSync(qualityPath)) throw new Error(`verify.py exit ${result.code}: ${result.stderr || result.stdout || 'no quality.json produced'}`);
    const metrics = JSON.parse(fs.readFileSync(qualityPath, 'utf8'));
    if (result.code !== 0 && !metrics.failures?.length) metrics.failures = [`verify.py exit ${result.code}: ${result.stderr}`];
    return { ok: result.code === 0 && metrics.failures.length === 0, failures: metrics.failures, warnings: metrics.warnings, metrics, qualityPath };
  } catch (error) {
    return { ok: false, failures: [error.message], warnings: [], metrics: {}, qualityPath };
  }
}
module.exports = { verify, assertDelays };
