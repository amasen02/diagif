'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const fg = require('fast-glob');
const defaults = require('../config/defaults.json');
const { ROOT, forward } = require('./paths.js');
const { normalizeScene } = require('./normalize-scene.js');
const { writeFileAtomic } = require('./fs-atomic.js');

function expandInputs(args, { cwd = process.cwd() } = {}) {
  const files = new Map();
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.length) throw new Error('Input paths must be non-empty strings');
    const normalized = forward(arg);
    const matches = fg.isDynamicPattern(normalized)
      ? fg.sync(fg.convertPathToPattern(normalized), { cwd, absolute: true, onlyFiles: true })
      : [path.resolve(cwd, normalized)];
    for (const match of matches) {
      const file = forward(path.resolve(cwd, match));
      files.set(process.platform === 'win32' ? file.toLowerCase() : file, file);
    }
  }
  if (!files.size) throw new Error('No input scenes matched');
  return [...files.values()].sort();
}

function message(error) { return error instanceof Error ? error.message : String(error); }

// Never point an encoder at a promoted output. Even a partially written candidate
// or a throwing verifier must leave the previous deliverable intact.
async function promote(source, destination) {
  await writeFileAtomic(destination, await fs.readFile(source));
}

async function writeManifest(manifestPath, manifest) {
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

/**
 * Run one injected capture/encode/verify candidate per scene. The integration
 * adapter owns encoder discovery, candidate optimization and the size ladder.
 * options.rung is a config rung (default: rung 0); all stage signatures follow
 * docs/CONTRACT.md. No stage imports or process.exit calls occur in this module.
 */
async function runBatch(inputs, stages = {}, options = {}) {
  const files = expandInputs(inputs, options);
  const maxParallelScenes = options.maxParallelScenes ?? defaults.maxParallelScenes;
  if (!Number.isInteger(maxParallelScenes) || maxParallelScenes < 1) {
    throw new Error('maxParallelScenes must be a positive integer');
  }
  const root = path.resolve(options.rootDir || ROOT);
  const outputDir = path.resolve(options.outputDir || path.join(root, 'output'));
  const workRoot = path.resolve(options.workRoot || path.join(root, 'work'));
  const manifestPath = path.resolve(options.manifestPath || path.join(outputDir, 'manifest.json'));
  const rung = { ...defaults.ladder[0], ...options.rung };
  if (![40, 50].includes(rung.stepMs) || rung.width !== 800 || rung.safeOnly) {
    throw new Error('Batch primary rung must use width 800, stepMs 40 or 50, and cannot be safeOnly');
  }
  const caps = { ...defaults.caps, ...options.caps };
  const launchArgs = options.launchArgs || defaults.launchArgs;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const entries = files.map(input => ({ input, id: null, status: 'pending', stage: 'load', warnings: [], timings: {} }));
  const scenes = [];

  // Preflight IDs before scheduling: two input files must never share a work
  // directory, including on Windows' case-insensitive filesystem.
  const owners = new Map();
  for (let i = 0; i < files.length; i++) {
    const entry = entries[i];
    try {
      const raw = JSON.parse(await fs.readFile(files[i], 'utf8'));
      entry.id = typeof raw?.id === 'string' ? raw.id : null;
      entry.stage = 'normalize';
      const scene = normalizeScene(raw);
      scenes[i] = scene;
      Object.assign(entry, {
        durationMs: scene.timeline.durationMs, stepMs: rung.stepMs,
        expectedFrames: scene.timeline.durationMs / rung.stepMs,
        loopSeam: scene.timeline.loopSeam || 'seamless',
        animations: scene.timeline.animations, warnings: [...scene.warnings],
        workDir: forward(path.join(workRoot, scene.id)),
        primaryPath: null, safeVariant: null, ladder: []
      });
      const indices = owners.get(scene.id) || [];
      indices.push(i); owners.set(scene.id, indices);
    } catch (error) { Object.assign(entry, { status: 'failed', error: message(error) }); }
  }
  for (const [id, indices] of owners) if (indices.length > 1) {
    for (const i of indices) Object.assign(entries[i], { status: 'failed', stage: 'normalize', error: 'Duplicate scene id in batch: ' + id });
  }
  await fs.mkdir(outputDir, { recursive: true });

  async function processScene(index) {
    const entry = entries[index], scene = scenes[index];
    if (entry.status === 'failed') return;
    const sceneStart = performance.now();
    async function stage(name, job) {
      entry.stage = name;
      const stageStart = performance.now();
      try {
        if (typeof stages[name] !== 'function') throw new Error('Render stage "' + name + '" is not injected; Phase 2 must wire capture, encode and verify');
        return await job(stages[name]);
      } finally { entry.timings[name + 'Ms'] = Math.round(performance.now() - stageStart); }
    }
    try {
      await fs.mkdir(entry.workDir, { recursive: true });
      const captured = await stage('capture', fn => fn(scene, { workDir: entry.workDir, stepMs: rung.stepMs, launchArgs }));
      if (!captured?.framesDir || !Array.isArray(captured.framePaths) || !captured.framePaths.length) {
        throw new Error('Capture must return framesDir and non-empty framePaths');
      }
      for (const key of ['framesDir', 'seamPath', 'frameHashes', 'identicalRanges', 'fonts', 'playwrightVersion', 'browserVersion', 'os', 'launchArgs', 'geometrySelfCheck']) {
        if (captured[key] !== undefined) entry[key] = captured[key];
      }
      entry.os ??= os.platform() + ' ' + os.release();
      entry.launchArgs ??= launchArgs;
      entry.warnings.push(...(captured.warnings || []));
      const reservedColors = typeof options.reservedColors === 'function'
        ? await options.reservedColors(scene) : options.reservedColors || [];
      const candidateDir = await fs.mkdtemp(path.join(entry.workDir, 'candidate-'));
      const encoded = await stage('encode', fn => fn({ scene, framesDir: captured.framesDir,
        framePaths: captured.framePaths, stepMs: rung.stepMs, rung,
        outPath: forward(path.join(candidateDir, 'primary.gif')), reservedColors }));
      if (!encoded?.gifPath) throw new Error('Encode must return gifPath');
      const selectedCapture = encoded.captured || captured;
      for (const key of ['framesDir', 'seamPath', 'frameHashes', 'identicalRanges', 'fonts', 'playwrightVersion', 'browserVersion', 'os', 'launchArgs', 'geometrySelfCheck']) {
        if (selectedCapture[key] !== undefined) entry[key] = selectedCapture[key];
      }
      entry.stepMs = encoded.stepMs || rung.stepMs;
      entry.expectedFrames = scene.timeline.durationMs / entry.stepMs;
      for (const key of ['encoder', 'encoderVersion', 'version', 'rung', 'candidate', 'argv', 'paletteMethod', 'postprocess', 'lossy', 'tool']) {
        if (encoded[key] !== undefined) entry[key] = encoded[key];
      }
      entry.rung ??= rung.rung;
      entry.candidate ??= 'raw';
      entry.warnings.push(...(encoded.warnings || []));
      const stat = await fs.stat(encoded.gifPath);
      if (!stat.isFile() || !stat.size) throw new Error('Encoder did not produce a non-empty GIF candidate');
      entry.bytes = stat.size;
      const attempt = { rung: entry.rung, candidate: entry.candidate, bytes: stat.size, passed: false, failures: [] };
      if (encoded.ladder) entry.ladder = encoded.ladder;
      else entry.ladder.push(attempt);
      let quality;
      try {
        quality = await stage('verify', fn => fn({ gifPath: encoded.gifPath, framesDir: encoded.framesDir || captured.framesDir,
          expectedWidth: 800, expectedHeight: scene.canvas.height, expectedDurationMs: scene.timeline.durationMs,
          stepMs: entry.stepMs, maxBytes: caps.hardMaxBytes, strictFrameCount: scene.timeline.strictFrameCount,
          reservedColors: encoded.reservedColors || reservedColors, lossy: Boolean(encoded.lossy), encoder: encoded.encoder }));
        attempt.failures = [...(quality?.failures || [])];
        if (stat.size > caps.hardMaxBytes) attempt.failures.push('Candidate exceeds hardMaxBytes');
        if (quality?.ok !== true || attempt.failures.length) throw new Error('Quality gate failed: ' + (attempt.failures.join('; ') || 'verify did not return ok: true'));
        attempt.passed = true;
      } catch (error) {
        if (!attempt.failures.length) attempt.failures.push(message(error));
        throw error;
      }
      const metrics = quality.metrics || {};
      entry.quality = quality;
      entry.warnings.push(...(quality.warnings || []));
      for (const key of ['mergedFrames', 'loopSeamOk', 'flickerPixelCount', 'staticRegionMaxDiff', 'reservedColorHits', 'contactSheet']) {
        if (metrics[key] !== undefined) entry[key] = metrics[key];
      }
      entry.frameCount = metrics.frames ?? null;
      entry.primaryTargetMet = stat.size <= caps.primaryMaxBytes;
      const destination = path.join(outputDir, scene.id + '.gif');
      entry.stage = 'promote';
      await promote(encoded.gifPath, destination);
      entry.primaryPath = forward(destination);
      if (metrics.contactSheet) {
        const sheet = destination + '.contact.png';
        await promote(metrics.contactSheet, sheet);
        entry.contactSheet = metrics.contactSheet = forward(sheet);
      }
      quality.qualityPath = forward(destination + '.quality.json');
      await fs.writeFile(quality.qualityPath, JSON.stringify(metrics, null, 2) + '\n');
      await fs.writeFile(destination + '.encode.json', JSON.stringify({ encoder: encoded.encoder,
        reservedColors: encoded.reservedColors || reservedColors, lossy: !!encoded.lossy,
        candidate: entry.candidate, paletteMethod: entry.paletteMethod }, null, 2) + '\n');
      entry.safeVariant = entry.primaryTargetMet ? 'same-as-primary' : {
        status: 'failed', reason: 'This injected candidate exceeds primaryMaxBytes; the Phase 2 ladder adapter must supply a safe variant'
      };
      if (!entry.primaryTargetMet) entry.warnings.push(entry.safeVariant.reason);
      if (!entry.primaryTargetMet && encoded.safeVariant?.status === 'ok') {
        const safe = encoded.safeVariant, safePath = path.join(outputDir, scene.id + '-linkedin-safe.gif');
        await promote(safe.gifPath, safePath);
        if (safe.quality?.metrics?.contactSheet) await promote(safe.quality.metrics.contactSheet, safePath + '.contact.png');
        entry.safeVariant = { status: 'ok', path: forward(safePath), bytes: safe.bytes, rung: safe.rung };
        entry.warnings.pop();
      }
      entry.status = entry.primaryTargetMet || entry.safeVariant?.status === 'ok' ? 'ok' : 'partial';
      entry.stage = 'complete';
    } catch (error) { Object.assign(entry, { status: 'failed', error: message(error) }); if (error.ladder) entry.ladder = error.ladder; }
    finally { entry.timings.totalMs = Math.round(performance.now() - sceneStart); }
  }

  let next = 0;
  async function worker() {
    while (next < entries.length) { const index = next++; await processScene(index); }
  }
  await Promise.all(Array.from({ length: Math.min(maxParallelScenes, entries.length) }, worker));
  const exitCode = entries.every(entry => entry.status === 'ok') ? 0 : 1;
  const manifest = { schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
    maxParallelScenes, exitCode, timings: { totalMs: Math.round(performance.now() - start) }, scenes: entries };
  await writeManifest(manifestPath, manifest);
  return { exitCode, manifest, manifestPath: forward(manifestPath) };
}

module.exports = { expandInputs, runBatch };
