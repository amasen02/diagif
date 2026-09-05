'use strict';
const fs = require('node:fs');
const path = require('node:path');
const defaults = require('../../config/defaults.json');
const { rootPath } = require('../paths.js');
const gifski = require('./gifski.js');
const pillow = require('./pillow-encoder.js');
const gifsicle = require('./gifsicle.js');
const quality = require('../quality/quality-gate.js');

function listFrames(framesDir) {
  return fs.readdirSync(framesDir).filter(name => /^frame_\d{4}\.png$/.test(name)).sort((a, b) => Number(a.slice(6, 10)) - Number(b.slice(6, 10))).map(name => path.resolve(framesDir, name));
}
function validateFrames(framePaths, expectedFrames) {
  if (!Number.isInteger(expectedFrames) || expectedFrames < 1 || expectedFrames > 250 || framePaths.length !== expectedFrames) throw new Error('Source frame count must equal duration / step and be between 1 and 250');
  const paths = framePaths.map(p => path.resolve(p)).sort((a, b) => Number(path.basename(a).slice(6, 10)) - Number(path.basename(b).slice(6, 10)));
  for (let i = 0; i < paths.length; i++) if (path.basename(paths[i]) !== `frame_${String(i).padStart(4, '0')}.png` || !fs.statSync(paths[i]).isFile()) throw new Error('Frames must form a contiguous frame_0000.png sequence');
  return paths;
}
function resolveReservedColors(scene) {
  if (!scene) return [];
  const themes = require('../renderer/themes.js');
  const theme = themes.get(scene.theme), colors = new Set();
  const add = color => { if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) colors.add(color.toUpperCase()); };
  add(theme.bg); add(theme.titleText);
  for (const node of scene.nodes || []) {
    const role = themes.role(theme, node.colorRole), style = node.style || {};
    const panel = node.shape === 'panel', card = node.shape === 'card';
    add(style.fill || (card ? '#0B0F12' : panel ? theme.panel : node.shape === 'step' ? theme.orange.soft : node.shape === 'window' ? '#F0F5F5' : role.fill));
    add(style.stroke || (card ? '#1C2428' : panel ? theme.panelBorder : role.stroke));
    add(style.textColor || (card ? '#FFFFFF' : panel ? theme.titleText : role.text));
    if (node.secondaryLabel) add(card || panel ? theme.muted : '#36555D');
    if (node.icon?.colorRole) add(themes.role(theme, node.icon.colorRole).stroke);
    if (node.badge !== undefined) { add(theme.orange.fill); add('#152F37'); }
  }
  for (const edge of scene.edges || []) add(themes.role(theme, edge.colorRole).stroke);
  for (const animation of scene.timeline?.animations || []) {
    if (animation.color) add(animation.color);
    else if (animation.colorRole) add(themes.role(theme, animation.colorRole).stroke);
    else if (animation.kind === 'particle-flow') add(theme.particle);
  }
  function explicit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && /^#[0-9a-f]{6}$/i.test(child)) add(child);
      else if (typeof child === 'object') explicit(child);
    }
  }
  explicit(scene);
  if (scene.title?.subtitle || scene.annotations?.length) add(theme.muted);
  for (const accent of scene.title?.accentWords || []) if (accent.colorRole && !accent.color) add(themes.role(theme, accent.colorRole).fill);
  for (const section of scene.layout?.sections || []) if (section.header && section.headerStyle !== 'plain') {
    add(section.colorRole ? themes.role(theme, section.colorRole).fill : theme.chip); add(theme.chipText);
  }
  for (const annotation of scene.annotations || []) {
    if (annotation.colorRole) add(themes.role(theme, annotation.colorRole).stroke);
    if (annotation.kind === 'check') add(theme.success.stroke);
    if (annotation.kind === 'cross') add(theme.danger.stroke);
  }
  if (scene.brand?.style === 'bar') {
    add(theme.footer); add(theme.footerText);
    if (scene.brand.url) add(scene.brand.urlColorRole ? themes.role(theme, scene.brand.urlColorRole).fill : theme.link);
  }
  return [...colors];
}
async function chooseEncoder(requested = 'auto') {
  if (!['auto', 'pillow', 'gifski'].includes(requested)) throw new Error('encoder must be auto, pillow or gifski');
  if (requested === 'pillow') return { encoder: 'pillow' };
  const tool = await gifski.discover();
  if (tool) return { encoder: 'gifski', tool };
  if (requested === 'gifski') throw new Error('gifski unavailable');
  return { encoder: 'pillow' };
}
async function encode(options) {
  const { scene, framesDir, outPath } = options;
  if (!outPath || !framesDir) throw new Error('outPath and framesDir are required');
  const selection = options.selection || await chooseEncoder(options.encoder || options.rung?.encoder || 'auto');
  const presets = selection.encoder === 'pillow' ? defaults.pillowLadder : defaults.ladder;
  const rungId = typeof options.rung === 'number' ? options.rung : options.rung?.rung ?? 0;
  const preset = presets.find(r => r.rung === rungId);
  if (!preset) throw new Error(`Unsupported ${selection.encoder} rung ${rungId}`);
  const rung = { ...preset, ...(typeof options.rung === 'object' ? options.rung : {}) };
  const stepMs = options.stepMs ?? rung.stepMs;
  if (![40, 50].includes(stepMs)) throw new Error('stepMs must be 40 or 50');
  const rawPaths = options.framePaths || listFrames(framesDir);
  const duration = options.durationMs ?? scene?.timeline?.durationMs ?? rawPaths.length * stepMs;
  const framePaths = validateFrames(rawPaths, duration / stepMs);
  const reservedColors = options.reservedColors ?? resolveReservedColors(scene);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const logPath = options.logPath || path.join(path.dirname(path.resolve(framesDir)), `encode-${rungId}.log`);
  const common = { ...rung, ...options, outPath: path.resolve(outPath), width: options.width ?? rung.width, framePaths, stepMs, fps: 1000 / stepMs, reservedColors, logPath };
  if (!Number.isInteger(common.width) || common.width <= 0) throw new Error('width must be a positive integer');
  const result = selection.encoder === 'gifski'
    ? await gifski.encode({ ...common, tool: selection.tool, expectedFrames: duration / stepMs, fixedColors: reservedColors })
    : await pillow.encode(common);
  return { ...result, encoderVersion: selection.tool?.version || result.python?.pillowVersion,
    rung: rungId, candidate: 'raw', lossy: false, reservedColors, width: common.width, stepMs, framesDir: path.resolve(framesDir) };
}

/** Encoder-homogeneous ladder. capture(scene, {workDir,stepMs,width}) supplies new grids.
 * Tests/integrators may inject stages via {encode,verify,capture,optimize,discoverGifsicle}.
 * Returns {ok,status,primary,primaryPath,safeVariant,ladder,encoder,manifestPath}.
 */
async function runLadder(options, stages = {}) {
  const scene = options.scene;
  if (!scene?.timeline?.durationMs) throw new Error('runLadder requires a normalized scene');
  const workDir = path.resolve(options.workDir || rootPath('work', scene.id));
  const outPath = path.resolve(options.outPath || rootPath('output', scene.id + '.gif'));
  fs.mkdirSync(workDir, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(workDir, 'ladder-'));
  const selection = stages.encode ? { encoder: options.encoder === 'pillow' ? 'pillow' : 'gifski' } : await chooseEncoder(options.encoder);
  const rungs = selection.encoder === 'pillow' ? defaults.pillowLadder : defaults.ladder;
  const caps = { ...defaults.caps, ...options.caps };
  const doEncode = stages.encode || encode, doVerify = stages.verify || quality.verify;
  const capture = stages.capture || options.capture;
  const optimizer = stages.optimize || gifsicle.optimize;
  const optimizerTool = await (stages.discoverGifsicle || gifsicle.discover)();
  const reservedColors = options.reservedColors ?? resolveReservedColors(scene);
  const cache = new Map(), kept = new Map(), ladder = [];
  if (options.framesDir) cache.set(`${options.stepMs || 40}:800:true`, { framesDir: options.framesDir, framePaths: options.framePaths || listFrames(options.framesDir) });
  async function captureRung(rung) {
    const key = `${rung.stepMs}:${rung.width}:${rung.grain !== false}`;
    if (!cache.has(key)) {
      if (typeof capture !== 'function') throw new Error(`Rung ${rung.rung} needs re-capture at ${rung.stepMs} ms; inject capture (never resample)`);
      const captureScene = rung.grain === false ? { ...scene, grain: false } : scene;
      // Isolate the grain-free 720 capture from the 800px grid; frozen capture uses canvas.width=800.
      const captureWork = rung.width === 800 ? workDir : path.join(workDir, `safe-${rung.width}`);
      const captured = await capture(captureScene, { workDir: captureWork, stepMs: rung.stepMs, width: rung.width, launchArgs: options.launchArgs || defaults.launchArgs });
      cache.set(key, captured);
    }
    return cache.get(key);
  }
  async function attempt(rung) {
    if (kept.has(rung.rung)) return kept.get(rung.rung);
    let raw, captured;
    try {
      captured = await captureRung(rung);
      raw = await doEncode({ scene, ...captured, width: rung.width, stepMs: rung.stepMs, rung, outPath: path.join(runDir, `rung-${rung.rung}-raw.gif`), reservedColors, selection, encoder: selection.encoder, compareStabilized: true });
    } catch (error) {
      ladder.push({ rung: rung.rung, candidate: 'raw', bytes: null, passed: false, failures: [error.message] });
      kept.set(rung.rung, null); return null;
    }
    const candidates = [];
    if (raw.postprocess?.nativePath) candidates.push({ ...raw, gifPath: raw.postprocess.nativePath,
      candidate: 'native', postprocess: { applied: false }, paletteMethod: 'gifski', warnings: [] });
    raw.candidate = raw.postprocess?.applied ? 'stabilized' : raw.encoder === 'gifski' ? 'native' : 'raw';
    candidates.push(raw);
    if (optimizerTool) for (const lossy of [false, true]) {
      const candidate = lossy ? 'lossy' : 'o3';
      try {
        const optimized = await optimizer({ gifPath: raw.gifPath, outPath: path.join(runDir, `rung-${rung.rung}-${candidate}.gif`), lossy, tool: optimizerTool });
        if (optimized) candidates.push({ ...raw, ...optimized, encoder: raw.encoder,
          candidate: raw.candidate === 'stabilized' ? 'stabilized-' + candidate : candidate, lossy });
      } catch (error) { ladder.push({ rung: rung.rung, candidate, bytes: null, passed: false, failures: [error.message] }); }
    }
    let best = null, passingNative = null;
    for (const candidate of candidates) {
      try {
        const bytes = fs.statSync(candidate.gifPath).size;
        const gate = await doVerify({ gifPath: candidate.gifPath, framesDir: captured.framesDir, expectedWidth: rung.width,
          expectedHeight: Math.round(scene.canvas.height * rung.width / 800), expectedDurationMs: scene.timeline.durationMs,
          stepMs: rung.stepMs, maxBytes: caps.hardMaxBytes, strictFrameCount: scene.timeline.strictFrameCount,
          reservedColors, lossy: !!candidate.lossy, encoder: selection.encoder });
        const failures = [...(gate.failures || [])];
        if (bytes > caps.hardMaxBytes && !failures.includes('GIF exceeds maxBytes')) failures.push('GIF exceeds maxBytes');
        const passed = gate.ok === true && failures.length === 0;
        ladder.push({ rung: rung.rung, candidate: candidate.candidate || 'raw', bytes, passed, failures,
          flickerPixelCount: gate.metrics?.flickerPixelCount, staticRegionMaxDiff: gate.metrics?.staticRegionMaxDiff,
          warnings: [...(candidate.warnings || []), ...(gate.warnings || [])], gifPath: candidate.gifPath, qualityPath: gate.qualityPath, argv: candidate.argv, tool: candidate.tool, paletteMethod: candidate.paletteMethod, postprocess: candidate.postprocess, droppedFlags: candidate.droppedFlags || [] });
        const eligible = passed && (gate.metrics?.flickerPixelCount || 0) <= (defaults.candidatePolicy?.maxPromotedFlickerPixels ?? 0);
        const selected = { ...candidate, bytes, rung: rung.rung, width: rung.width, stepMs: rung.stepMs,
          framesDir: captured.framesDir, captured, quality: gate,
          encoderVersion: candidate.encoderVersion || candidate.tool?.version || candidate.python?.pillowVersion,
          paletteMethod: candidate.postprocess?.paletteMethod || candidate.paletteMethod || selection.encoder };
        if (eligible && candidate.candidate === 'native') passingNative = selected;
        if (eligible && (candidate === raw || candidate.candidate === 'native' || bytes < fs.statSync(raw.gifPath).size) && (!best || bytes < best.bytes)) best = selected;
      } catch (error) { ladder.push({ rung: rung.rung, candidate: candidate.candidate, bytes: null, passed: false, failures: [error.message] }); }
    }
    // Preserve native colour fidelity whenever its own strict gate passes.
    best = defaults.candidatePolicy?.preferPassingNative === false ? best : passingNative || best;
    kept.set(rung.rung, best); return best;
  }
  let primary = null, firstUnderHard = null;
  for (const rung of rungs.filter(r => !r.safeOnly)) {
    const candidate = await attempt(rung);
    if (candidate && !firstUnderHard) firstUnderHard = candidate;
    if (candidate && candidate.bytes <= caps.primaryMaxBytes) { primary = candidate; break; }
  }
  primary ||= firstUnderHard;
  let safeVariant = { status: 'failed', reason: 'No passing primary candidate' }, primaryPath = null;
  function promote(candidate, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = destination + `.${process.pid}.tmp`;
    fs.copyFileSync(candidate.gifPath, temporary); fs.renameSync(temporary, destination);
    return { ...candidate, gifPath: destination };
  }
  if (primary) {
    primary = promote(primary, outPath); primaryPath = outPath;
    if (primary.bytes <= caps.primaryMaxBytes) safeVariant = 'same-as-primary';
    else {
      safeVariant = { status: 'failed', reason: 'No safe candidate meets primaryMaxBytes' };
      for (const rung of rungs.filter(r => r.rung >= 3)) {
        const candidate = await attempt(rung);
        if (candidate && candidate.bytes <= caps.primaryMaxBytes) {
          const safePath = outPath.replace(/\.gif$/i, '') + '-linkedin-safe.gif';
          safeVariant = { status: 'ok', ...promote(candidate, safePath) }; break;
        }
      }
    }
  }
  const ok = Boolean(primary) && (safeVariant === 'same-as-primary' || safeVariant.status === 'ok');
  const result = { ok, status: ok ? 'ok' : primary ? 'partial' : 'failed', encoder: selection.encoder, primary, primaryPath, safeVariant, ladder, manifestPath: path.join(runDir, 'manifest.json') };
  fs.writeFileSync(result.manifestPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}
module.exports = { encode, runLadder, listFrames, validateFrames, resolveReservedColors, chooseEncoder };
