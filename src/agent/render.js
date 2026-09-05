'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { writeFileAtomic } = require('../fs-atomic.js');
const { ROOT } = require('../paths.js');
const { AgentRenderError, AgentQualityGateError } = require('./errors.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function contained(root, file) {
  if (typeof file !== 'string') return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

async function verifyRenderArtifacts(rendered, runDir = path.dirname(path.dirname(rendered.manifestPath))) {
  if (!rendered.artifactHashes?.length) return false;
  try {
    for (const artifact of rendered.artifactHashes) {
      if (!contained(runDir, artifact.promoted) || !contained(path.join(runDir, 'steps'), artifact.evidence)) return false;
      if (digest(await fs.readFile(artifact.evidence)) !== artifact.sha256) return false;
    }
    return true;
  } catch { return false; }
}

async function restorePromotedArtifacts(rendered, runDir) {
  if (!await verifyRenderArtifacts(rendered, runDir)) throw new AgentQualityGateError('Retained render artifacts are missing, changed or outside the run');
  for (const artifact of rendered.artifactHashes) {
    let matches = false;
    try { matches = digest(await fs.readFile(artifact.promoted)) === artifact.sha256; } catch {}
    if (!matches) await writeFileAtomic(artifact.promoted, await fs.readFile(artifact.evidence));
  }
}

function assertQualityGate(rendered) {
  const entry = rendered?.entry || rendered?.manifest?.scenes?.[0];
  if (!entry || rendered.exitCode !== 0 || entry.status !== 'ok') {
    const Type = entry?.stage === 'verify' || /quality|gate|passing primary/i.test(entry?.error || '') ? AgentQualityGateError : AgentRenderError;
    throw new Type(entry?.error || 'Render did not produce a passing artifact', { details: { manifestPath: rendered?.manifestPath, stage: entry?.stage } });
  }
  if (entry.quality?.ok !== true || entry.quality.failures?.length || entry.quality.metrics?.failures?.length) throw new AgentQualityGateError('Rendered candidate failed its quality gate');
  return rendered;
}

async function renderAgentSceneImpl(scene, runDir, attempt = 1, options = {}) {
  const runBatch = options.runBatch || require('../batch.js').runBatch;
  if (![1, 2].includes(attempt)) throw new AgentRenderError('Only two render attempts are allowed');
  const step = '04-render-a' + attempt, evidenceDir = path.join(runDir, 'steps', step);
  const sceneJson = path.join(evidenceDir, 'scene.json');
  await writeFileAtomic(sceneJson, JSON.stringify(scene, null, 2) + '\n');
  const start = Date.now(), timeoutMs = options.timeoutMs ?? 900000;
  const stages = options.stages || (options.realStages || require('../commands/render.js').realStages)(options), boundedStages = {};
  for (const name of ['capture', 'encode', 'verify']) boundedStages[name] = async (...args) => {
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) throw new AgentRenderError('Render deadline exceeded');
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => stages[name](...args)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AgentRenderError('Render deadline exceeded during ' + name)), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const result = await (options.runBatch || runBatch)([sceneJson], boundedStages, {
    rootDir: ROOT, outputDir: runDir, workRoot: path.join(runDir, 'work', 'a' + attempt),
    manifestPath: path.join(runDir, 'steps', step + '.manifest.json'),
    maxParallelScenes: 1, reservedColors: options.reservedColors || require('../encode/encode.js').resolveReservedColors,
    ...(options.batchOptions || {})
  });
  const entry = result.manifest.scenes[0];
  const rendered = { ...result, entry, gifPath: entry.primaryPath, contactSheet: entry.contactSheet,
    framesDir: entry.framesDir, seamPath: entry.seamPath, quality: entry.quality };
  assertQualityGate(rendered);
  // Keep each passing attempt independently reviewable after the next promotion.
  rendered.artifactHashes = [];
  for (const suffix of ['', '.contact.png', '.quality.json', '.encode.json']) {
    const source = entry.primaryPath + suffix;
    try {
      const bytes = await fs.readFile(source), evidence = path.join(evidenceDir, path.basename(source));
      await writeFileAtomic(evidence, bytes);
      rendered.artifactHashes.push({ evidence, promoted: source, sha256: digest(bytes) });
    }
    catch (error) { if (error.code !== 'ENOENT' || suffix !== '.contact.png') throw error; }
  }
  return rendered;
}

async function renderAgentScene(...args) {
  try { return await renderAgentSceneImpl(...args); }
  catch (error) {
    if (error instanceof AgentRenderError || error instanceof AgentQualityGateError) throw error;
    throw new AgentRenderError(error.message, { cause: error });
  }
}

module.exports = { renderAgentScene, assertQualityGate, verifyRenderArtifacts, restorePromotedArtifacts };
