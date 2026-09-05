'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const timeline = require('../src/renderer/timeline.js');
const geometry = require('../src/renderer/path-geometry.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const { rootPath } = require('../src/paths.js');
const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, a + ' != ' + b);
function finite(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'non-finite state');
  else if (value && typeof value === 'object') Object.values(value).forEach(finite);
}
function checkLoop(scene, stepMs) {
  const metrics = geometry.createPathMetrics(scene), engine = timeline.create(scene, metrics, { stepMs }), D = scene.timeline.durationMs;
  const zero = engine.state(0), last = engine.state(D - stepMs);
  assert.deepEqual(engine.state(D), zero);
  assert.deepEqual(engine.state(-stepMs), last);
  for (let t = 0; t < D; t += stepMs) {
    const state = engine.state(t); finite(state); assert.deepEqual(engine.state(t + D), state);
    for (const a of state) if (a.kind === 'particle-flow') for (const p of a.particles) assert.ok(p.opacity >= 0 && p.opacity <= 1);
  }
  zero.forEach((state, i) => {
    const a = scene.timeline.animations[i], previous = last[i];
    if (a.kind === 'particle-flow') state.particles.forEach((p, k) => {
      const before = previous.particles[k];
      const travel = timeline.mod(p.phase - before.phase, a.travelMs) * a.effectiveSpeedPxPerSec / 1000;
      assert.ok(travel <= a.effectiveSpeedPxPerSec * stepMs / 1000 + 0.01);
      if (p.phase >= before.phase && p.edgeId === before.edgeId) assert.ok(Math.hypot(p.x - before.x, p.y - before.y) <= travel + 0.01);
      if (p.phase < before.phase && a.fadeMs > 0) assert.equal(p.opacity, 0, 'chain wrap is invisible at seam');
    });
    else if (a.kind === 'marching-dash') {
      const period = a.dash + a.gap, wrapped = timeline.mod(previous.offset - state.offset, period);
      assert.ok(wrapped <= period * a.cycles * stepMs / D + 0.01);
    } else if (a.kind === 'pulse') {
      assert.ok(Math.abs(previous.scale - 1) <= (a.scale - 1) * (1 - Math.cos(2 * Math.PI * a.cycles * stepMs / D)) / 2 + 1e-9);
    }
  });
}
const files = fs.readdirSync(rootPath('scenes')).filter(f => f.endsWith('.json')).sort();
for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(rootPath('scenes', file), 'utf8'));
  const nodeIds = raw.nodes.slice(0, 2).map(n => n.id), edgeIds = raw.edges.map(e => e.id);
  const variants = [
    { kind: 'particle-flow', edgeIds, count: 2, cyclesPerLoop: 2, staggerMs: 1100, trail: 3, glow: true },
    { kind: 'marching-dash', edgeIds, dash: 8, gap: 8, cyclesPerLoop: 12 },
    { kind: 'pulse', nodeIds, cyclesPerLoop: 3 },
    { kind: 'sequential-highlight', order: raw.nodes.map(n => n.id), transitionMs: 160 },
    { kind: 'typing', targetId: nodeIds[0], mirrorTargetId: nodeIds[1], text: 'Loop closes', startMs: 200, durationMs: 1000 },
    { kind: 'reveal', targetIds: nodeIds, startMs: 200, durationMs: 1000 }
  ];
  for (const stepMs of [40, 50]) {
    test(file + ' authored animations close on ' + stepMs + ' ms grid', () => checkLoop(normalizeScene(raw), stepMs));
    for (const animation of variants) test(file + ' / ' + animation.kind + ' / ' + stepMs + ' ms periodic state', () => {
      const copy = structuredClone(raw);
      copy.timeline.animations = [animation];
      if (['typing', 'reveal'].includes(animation.kind)) copy.timeline.animations.push({ kind: 'pulse', nodeIds, cyclesPerLoop: 1 });
      checkLoop(normalizeScene(copy), stepMs);
    });
  }
}
test('negative modulo and staggered particle k=1 have finite positive phase', () => {
  assert.equal(timeline.mod(-1100, 4000), 2900);
  assert.equal(timeline.mod(-4000, 4000), 0);
  const raw = JSON.parse(fs.readFileSync(rootPath('scenes/mcp-vs-skills.json'), 'utf8'));
  raw.timeline.animations = [{ kind: 'particle-flow', edgeIds: [raw.edges[0].id], count: 2, cyclesPerLoop: 1, staggerMs: 1100 }];
  const scene = normalizeScene(raw), p = timeline.create(scene, geometry.createPathMetrics(scene)).state(0)[0].particles[1];
  assert.equal(p.phase, 2900); finite(p); assert.ok(p.opacity >= 0 && p.opacity <= 1);
  near(p.x, 185 + 115 * 2900 / 4000);
});
test('integer step arithmetic: 8 / 6400 and 7 / 6000 on both grids', () => {
  for (const [n, durationMs] of [[8, 6400], [7, 6000]]) for (const stepMs of [40, 50]) {
    const engine = timeline.create({ timeline: { durationMs, animations: [{ kind: 'sequential-highlight', order: Array.from({ length: n }, (_, i) => 'n' + i) }] } }, null, { stepMs });
    const counts = Array(n).fill(0);
    for (let t = 0; t < durationMs; t += stepMs) counts[engine.state(t)[0].step]++;
    assert.equal(engine.state(0)[0].step, 0); assert.equal(engine.state(durationMs - stepMs)[0].step, n - 1);
    if (n === 8) assert.deepEqual(counts, Array(8).fill(stepMs === 40 ? 20 : 16));
    else assert.ok(counts.every(c => stepMs === 40 ? c === 21 || c === 22 : c === 17 || c === 18));
    assert.deepEqual(engine.state(0), engine.state(durationMs));
  }
});
test('narrative hold, mirror, exit and cut phases are explicit', () => {
  const make = (kind, loopBehavior = 'fade', mode = 'fade-scale') => timeline.create({ timeline: { durationMs: 4000, animations: [{ kind, targetId: 'a', targetIds: ['a'], text: 'abcdefgh', startMs: 200, durationMs: 1000, exitMs: 400, loopBehavior, mode }] } });
  const typing = make('typing');
  assert.equal(typing.state(0)[0].text, ''); assert.equal(typing.state(200)[0].text, '');
  assert.equal(typing.state(700)[0].text, 'abcdefg'); assert.equal(typing.state(700)[0].mirrorText, 'abcdef');
  assert.equal(typing.state(1200)[0].text, 'abcdefgh'); assert.equal(typing.state(1200)[0].mirrorText, 'abcdefgh');
  assert.equal(typing.state(1200)[0].holdMs, 2400); near(typing.state(3800)[0].opacity, 0.875);
  for (const kind of ['typing', 'reveal']) {
    const cut = make(kind, 'cut'); assert.equal(cut.state(3960)[0].opacity, 1); assert.equal(cut.state(0)[0].holdMs, 2800);
    assert.deepEqual(cut.state(0), cut.state(4000));
  }
  for (const mode of ['fade', 'scale', 'fade-scale']) {
    const reveal = make('reveal', 'fade', mode);
    assert.equal(reveal.state(0)[0].opacity, 0);
    near(reveal.state(700)[0].opacity, mode === 'scale' ? 1 : 0.875);
    near(reveal.state(700)[0].scale, mode === 'fade' ? 1 : 0.9875);
    near(reveal.state(3800)[0].opacity, 0.875);
  }
});
test('trails use the selected capture grid and disappear before the chain start', () => {
  const path = geometry.buildPath({ pathType: 'straight' }, { x: 0, y: 0 }, { x: 400, y: 0 });
  const metrics = { length: () => path.length, pointAt: (_, s) => path.pointAt(s) };
  const scene = { timeline: { durationMs: 4000, animations: [{ kind: 'particle-flow', edgeIds: ['e'], count: 2, cyclesPerLoop: 1, fadeMs: 0, trail: 3, size: 10 }] } };
  for (const stepMs of [40, 50]) {
    const engine = timeline.create(scene, metrics, { stepMs });
    assert.equal(engine.state(0)[0].particles[0].trails.length, 0);
    const p = engine.state(500)[0].particles[0]; near(p.x, 50);
    near(p.trails[0].x, 50 - 2 * stepMs / 10); near(p.trails[0].opacity, 0.35); near(p.trails[2].radius, 5 * 0.8 ** 3);
  }
});
test('only supported grids and finite seeks are accepted; UMD needs no DOM', () => {
  for (const grid of [30, 1000 / (1000 / 30), 1000 / 33.333333, 0, NaN]) assert.throws(() => timeline.frameCount(4000, grid), /Unsupported sampling grid/);
  assert.equal(timeline.frameCount(4000, 40), 100); assert.equal(timeline.frameCount(4000, 50), 80);
  assert.throws(() => timeline.frameCount(12000, 40), /frame count/);
  assert.throws(() => timeline.mod(Infinity, 4000), /finite/);
  const context = {}; vm.createContext(context);
  for (const file of ['timeline', 'animations']) vm.runInContext(fs.readFileSync(rootPath('src/renderer', file + '.js'), 'utf8'), context);
  assert.equal(typeof context.TechGif.timeline.create, 'function'); assert.equal(typeof context.TechGif.animations.attach, 'function');
  const raw = JSON.parse(fs.readFileSync(rootPath('scenes/mcp-vs-skills.json'), 'utf8')); raw.timeline.fps = 1000 / 30;
  assert.throws(() => normalizeScene(raw), /constant|integer/);
});
