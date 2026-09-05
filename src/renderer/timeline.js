(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TechGif = Object.assign(root.TechGif || {}, { timeline: api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function mod(a, m) {
    if (!Number.isFinite(a) || !Number.isFinite(m) || m <= 0) throw new Error('mod requires finite arguments and a positive modulus');
    return ((a % m) + m) % m;
  }
  const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
  const easeOutCubic = n => 1 - (1 - clamp(n)) ** 3;
  const easeInCubic = n => clamp(n) ** 3;
  function frameCount(durationMs, stepMs = 40) {
    if (![40, 50].includes(stepMs)) throw new Error('Unsupported sampling grid: ' + stepMs);
    const count = durationMs / stepMs;
    if (!Number.isInteger(count) || count < 1 || count > 250) throw new Error('Invalid frame count: ' + count);
    return count;
  }
  function create(scene, pathMetrics, options = {}) {
    const D = scene.timeline.durationMs, stepMs = options.stepMs ?? 40;
    frameCount(D, stepMs);
    const animations = scene.timeline.animations.map(a => {
      const prepared = { ...a };
      if (a.kind === 'particle-flow') {
        prepared.lengths = a.edgeIds.map(id => pathMetrics.length(id));
        if (prepared.lengths.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('Particle paths must have positive finite lengths');
        prepared.chainLength = prepared.lengths.reduce((sum, n) => sum + n, 0);
        prepared.cycles = a.cycles ?? a.cyclesPerLoop ?? clamp(Math.round(a.speedPxPerSec * D / 1000 / prepared.chainLength), 1, 8);
        prepared.travelMs = a.travelMs ?? D / prepared.cycles;
        let distance = 0;
        prepared.segStartMs = a.segStartMs ?? prepared.lengths.map(length => { const start = distance / prepared.chainLength * prepared.travelMs; distance += length; return start; });
        prepared.segDurMs = a.segDurMs ?? prepared.lengths.map(length => length / prepared.chainLength * prepared.travelMs);
        prepared.offsetsMs = a.offsetsMs ?? Array.from({ length: a.count }, (_, k) => k * (a.staggerMs ?? prepared.travelMs / a.count));
      } else if (a.kind === 'marching-dash') {
        prepared.dash = a.dash ?? 8; prepared.gap = a.gap ?? 8;
        prepared.period = prepared.dash + prepared.gap;
        prepared.cycles = a.cycles ?? a.cyclesPerLoop ?? Math.max(1, Math.round((a.speedPxPerSec ?? 50) * D / 1000 / prepared.period));
      } else if (a.kind === 'pulse') prepared.cycles = a.cycles ?? a.cyclesPerLoop ?? Math.max(1, Math.round(D / a.periodMs));
      else if (!['sequential-highlight', 'typing', 'reveal'].includes(a.kind)) throw new Error('Unknown animation kind: ' + a.kind);
      return prepared;
    });
    function position(a, phase) {
      let i = a.segStartMs.length - 1;
      while (i > 0 && a.segStartMs[i] > phase) i--;
      const distance = clamp((phase - a.segStartMs[i]) / a.segDurMs[i]) * a.lengths[i];
      return { edgeId: a.edgeIds[i], distance, ...pathMetrics.pointAt(a.edgeIds[i], distance) };
    }
    function evaluate(a, tm, index) {
      const base = { kind: a.kind, index };
      if (a.kind === 'particle-flow') {
        const radius = (a.size ?? 9) / 2, fadeMs = a.fadeMs ?? 160;
        const particles = a.offsetsMs.map((offset, k) => {
          const phase = mod(tm - offset, a.travelMs);
          const opacity = fadeMs === 0 ? 1 : clamp(Math.min(phase, a.travelMs - phase) / fadeMs);
          const trails = [];
          for (let j = 1; j <= (a.trail ?? 0); j++) {
            const trailPhase = phase - j * 2 * stepMs;
            if (trailPhase >= 0) trails.push({ ...position(a, trailPhase), opacity: opacity * 0.35 / j, radius: radius * 0.8 ** j, trailIndex: j });
          }
          return { particleIndex: k, phase, ...position(a, phase), opacity, radius, trails };
        });
        return { ...base, particles };
      }
      if (a.kind === 'marching-dash') return { ...base, edgeIds: a.edgeIds, dash: a.dash, gap: a.gap, period: a.period, offset: tm === 0 ? 0 : -(a.period * a.cycles * tm / D) };
      if (a.kind === 'pulse') {
        const p = mod(tm * a.cycles, D) / D;
        return { ...base, nodeIds: a.nodeIds, scale: 1 + ((a.scale ?? 1.06) - 1) * (1 - Math.cos(2 * Math.PI * p)) / 2 };
      }
      if (a.kind === 'sequential-highlight') {
        const n = a.order.length, step = Math.floor(tm * n / D), previous = mod(step - 1, n);
        const weight = (a.transitionMs ?? 0) === 0 ? 1 : clamp((tm - step * D / n) / a.transitionMs);
        const nodes = a.order.map((id, i) => {
          const w = i === step ? weight : i === previous ? 1 - weight : 0;
          return { id, weight: w, scale: 1 + ((a.scale ?? 1.06) - 1) * w, opacity: scene.layout?.kind === 'mindmap' ? 1 : 0.85 + 0.15 * w };
        });
        return { ...base, step, previous, weight, nodes };
      }
      const exitMs = a.loopBehavior === 'cut' ? 0 : (a.exitMs ?? 320);
      const holdMs = D - a.startMs - a.durationMs - exitMs;
      if (holdMs < 0) throw new Error('Narrative phases exceed loop duration');
      const entered = tm >= a.startMs, entering = entered && tm < a.startMs + a.durationMs;
      const progress = entered ? easeOutCubic((tm - a.startMs) / a.durationMs) : 0;
      const exitOpacity = exitMs > 0 && tm >= D - exitMs ? 1 - easeInCubic((tm - (D - exitMs)) / exitMs) : 1;
      if (a.kind === 'typing') {
        const chars = !entered ? 0 : entering ? Math.floor(a.text.length * progress) : a.text.length;
        return { ...base, targetId: a.targetId, mirrorTargetId: a.mirrorTargetId, text: a.text.slice(0, chars), mirrorText: a.text.slice(0, entering ? Math.max(0, chars - 1) : chars), opacity: exitOpacity, holdMs };
      }
      const mode = a.mode ?? 'fade-scale';
      return { ...base, targetIds: a.targetIds, opacity: !entered ? 0 : (mode === 'scale' ? 1 : progress) * exitOpacity,
        scale: mode === 'fade' ? 1 : 0.9 + 0.1 * progress, holdMs };
    }
    function state(timeMs) {
      const tm = mod(timeMs, D);
      return animations.map((a, index) => evaluate(a, tm, index));
    }
    return { state, seek: state, frameCount: grid => frameCount(D, grid ?? stepMs), stepMs, durationMs: D };
  }
  return { mod, clamp, easeOutCubic, easeInCubic, frameCount, create };
});
