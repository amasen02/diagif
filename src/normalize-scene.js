'use strict';
const fs = require('node:fs');
const { assertValid, contentZone, resolveArt } = require('./schema.js');
const { createPathMetrics } = require('./renderer/path-geometry.js');
const defaults = require('../config/defaults.json');
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
function inlineArt(name) {
  const file = resolveArt(name);
  if (!file) throw new Error('Art asset not found: ' + name);
  const bytes = fs.readFileSync(file), svg = file.endsWith('.svg');
  if (svg && /<(?:script|foreignObject)\b|\bon\w+\s*=|(?:href|src)\s*=\s*["'](?!data:|#)|url\(\s*(?!["']?data:|["']?#)|<!ENTITY/i.test(bytes.toString())) throw new Error('Art SVG must be self-contained and inert: ' + name);
  return 'data:image/' + (svg ? 'svg+xml' : 'png') + ';base64,' + bytes.toString('base64');
}
// Validation materializes mind maps on this clone; authored input is never modified.
function normalizeScene(input) {
  const scene = assertValid(JSON.parse(JSON.stringify(input))), warnings = [], D = scene.timeline.durationMs;
  scene.grain ??= defaults.themeDefaults.grain;
  scene.layout ??= { kind: 'freeform' };
  scene.assets = {};
  for (const node of scene.nodes) if (node.icon?.source === 'art') scene.assets['art:' + node.icon.name] = inlineArt(node.icon.name);
  for (const key of ['logoAsset', 'mascotAsset', 'avatarAsset']) if (scene.brand?.[key]?.startsWith('art:')) { const ref = scene.brand[key]; scene.assets[ref] = inlineArt(ref.slice(4)); scene.brand[key] = scene.assets[ref]; }
  const zone = contentZone(scene);
  if (scene.layout.kind === 'split-comparison' && !scene.layout.sections?.length) {
    const divider = scene.layout.dividerY;
    scene.layout.sections = [
      { id: 'section-1', y: zone.y, h: divider - zone.y, header: scene.layout.labels?.[0] || '', headerStyle: 'chip', labelAlign: 'left' },
      { id: 'section-2', y: divider, h: zone.bottom - divider, header: scene.layout.labels?.[1] || '', headerStyle: 'chip', labelAlign: 'left' }
    ];
  }
  const metrics = createPathMetrics(scene);
  const hint = (kind, label, effective, requested, i) => { if (requested !== undefined && Math.abs(effective / requested - 1) > 0.25) warnings.push(kind + '[' + i + '] ' + label + ' hint ' + requested + ' normalized to ' + effective + ' (>25% deviation)'); };
  scene.timeline.loop ??= true;
  scene.timeline.grids = { '40': D / 40, '50': D / 50 };
  scene.timeline.animations.forEach((a, i) => {
    if (a.kind === 'particle-flow') {
      const lengths = a.edgeIds.map(id => metrics.length(id)), chainLen = lengths.reduce((sum, n) => sum + n, 0);
      a.cycles = a.cyclesPerLoop ?? Math.max(1, Math.min(8, Math.round(a.speedPxPerSec * D / 1000 / chainLen)));
      a.travelMs = D / a.cycles;
      let traversed = 0;
      a.segStartMs = lengths.map(length => { const start = traversed / chainLen * a.travelMs; traversed += length; return start; });
      a.segDurMs = lengths.map(length => length / chainLen * a.travelMs);
      a.offsetsMs = Array.from({ length: a.count }, (_, k) => a.staggerMs !== undefined ? k * a.staggerMs : k * a.travelMs / a.count);
      a.effectiveSpeedPxPerSec = chainLen * a.cycles * 1000 / D;
      hint(a.kind, 'speed', a.effectiveSpeedPxPerSec, a.speedPxPerSec, i);
    } else if (a.kind === 'marching-dash') {
      const period = a.dash + a.gap;
      a.cycles = a.cyclesPerLoop ?? Math.max(1, Math.round(a.speedPxPerSec * D / 1000 / period));
      a.effectiveSpeedPxPerSec = period * a.cycles * 1000 / D;
      for (const id of a.edgeIds) scene.edges.find(e => e.id === id).dashed = true;
      hint(a.kind, 'speed', a.effectiveSpeedPxPerSec, a.speedPxPerSec, i);
    } else if (a.kind === 'pulse') {
      a.cycles = a.cyclesPerLoop ?? Math.max(1, Math.round(D / a.periodMs));
      a.effectivePeriodMs = D / a.cycles;
      hint(a.kind, 'period', a.effectivePeriodMs, a.periodMs, i);
      // A non-divisor period is observable even when rounding changes it by <=25%.
      if (a.periodMs !== undefined && a.effectivePeriodMs !== a.periodMs && Math.abs(a.effectivePeriodMs / a.periodMs - 1) <= 0.25) warnings.push('pulse[' + i + '] period hint ' + a.periodMs + ' rounded to ' + a.effectivePeriodMs + ' for an integer cycle count');
    } else if (a.kind === 'sequential-highlight') {
      a.stepStartsMs = a.order.map((_, index) => index * D / a.order.length);
    } else {
      if (a.loopBehavior === 'cut') a.exitMs = 0;
      a.holdMs = D - a.startMs - a.durationMs - a.exitMs;
    }
  });
  if (scene.timeline.animations.some(a => a.loopBehavior === 'cut')) scene.timeline.loopSeam = 'cut';
  scene.warnings = warnings;
  return sorted(scene);
}
module.exports = { normalizeScene, normalize: normalizeScene, sorted };
