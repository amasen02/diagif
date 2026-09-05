'use strict';

const path = require('node:path');
const { resolvePython, runProcess } = require('../python.js');
const { AgentRenderError } = require('./errors.js');
const ambient = new Set(['particle-flow', 'marching-dash', 'pulse', 'sequential-highlight']);

async function createCriticImages(rendered, outDir, { pythonResolver = resolvePython, processRunner = runProcess, timeoutMs = 60000 } = {}) {
  const python = await pythonResolver();
  const args = [path.join(__dirname, 'tile-frames.py'), '--frames-dir', rendered.framesDir || rendered.entry.framesDir, '--out', outDir];
  // The last sampled frame precedes frame zero; the exact seam is independently hash-gated.
  const result = await processRunner(python.command, [...(python.args || []), ...args], { timeout: timeoutMs });
  if (result.code !== 0) throw new AgentRenderError('Critic image tiling failed: ' + result.stderr.trim());
  const value = JSON.parse(result.stdout);
  if (!Array.isArray(value.images) || !value.images.length || value.images.length > 3) throw new AgentRenderError('Critic tiler returned no bounded images');
  return value.images;
}

function heuristicCritic({ rendered, scene, inspection }) {
  const entry = rendered.entry || {}, quality = rendered.quality || entry.quality || {}, metrics = quality.metrics || {};
  const animations = scene.timeline?.animations || [], count = scene.nodes?.length || 0;
  const mindmap = scene.layout?.kind === 'mindmap';
  const overlap = inspection?.ok === true && !(inspection.errors || []).some(e => /overlap|inset|two lines/i.test(e.message));
  const seam = metrics.loopSeamOk === true && (metrics.flickerPixelCount ?? 0) === 0 && quality.ok === true && !(quality.failures || []).length && !(metrics.failures || []).length;
  const motion = (entry.identicalRanges || []).length <= 3 && animations.some(a => ambient.has(a.kind));
  const intent = count >= (mindmap ? 9 : 5) && count <= (mindmap ? 25 : 9);
  const brand = inspection?.brand?.ok === true;
  const checks = { readability: 'unmeasured', overlap: overlap && intent ? 'pass' : 'fail', seam: seam ? 'pass' : 'fail',
    motion: motion ? 'pass' : 'fail', hook: 'unmeasured', brand: brand ? 'pass' : 'fail' };
  const edits = Object.entries(checks).filter(([, v]) => v === 'fail').map(([target]) => ({
    target, instruction: ({ overlap: 'Fix measured overlaps, label overflow, and node count to match the brief.',
      seam: 'Restore a seamless loop with zero flicker and passing quality gates.', motion: 'Add continuous ambient animation and remove static holds.',
      brand: 'Use exactly the configured URL footer at 16 px, or no brand.' })[target], severity: 'must'
  }));
  return { mode: 'heuristic', verdict: edits.length ? 'repair' : 'pass', checks, edits };
}

async function critic(context) {
  const measured = heuristicCritic(context);
  if (!context.brain.capability?.vision) {
    // Scripted mock verdicts exercise the bounded repair branch without claiming vision.
    if (context.brain.name?.startsWith('mock') && context.complete) {
      const scripted = await context.complete({ images: [], measured });
      return { ...scripted, mode: 'heuristic', checks: { ...scripted.checks, ...measured.checks },
        verdict: measured.verdict === 'repair' ? 'repair' : scripted.verdict,
        edits: [...measured.edits, ...scripted.edits].slice(0, 6) };
    }
    return measured;
  }
  let verdict;
  try { verdict = await context.complete({ images: context.images, measured }); }
  catch (error) { if (error.exitCode === 3) return measured; throw error; }
  const checks = { ...verdict.checks,
    seam: measured.checks.seam, motion: measured.checks.motion, brand: measured.checks.brand,
    ...(measured.checks.overlap === 'fail' ? { overlap: 'fail' } : {}) };
  return { ...verdict, mode: 'vision', checks,
    verdict: Object.values(checks).includes('fail') ? 'repair' : verdict.verdict,
    edits: [...measured.edits, ...verdict.edits].slice(0, 6) };
}

module.exports = { critic, heuristicCritic, createCriticImages };
