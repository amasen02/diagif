'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/renderer/path-geometry.js');
const scene = require('./fixtures/mcp-vs-skills.original.json');
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' != ' + expected);
test('anchors use node bounding boxes', () => {
  const n = { x: 10, y: 20, w: 100, h: 60 };
  assert.deepEqual(['top', 'right', 'bottom', 'left', 'center'].map(s => g.anchor(n, s)), [{ x: 60, y: 20 }, { x: 110, y: 50 }, { x: 60, y: 80 }, { x: 10, y: 50 }, { x: 60, y: 50 }]);
});
test('example chain lengths and individual paths are frozen', () => {
  const paths = g.buildScenePaths(scene);
  const top = scene.edges.slice(0, 3).map(e => e.id), bottom = scene.edges.slice(3).map(e => e.id);
  assert.deepEqual(top.map(id => paths[id].length), [115, 115, 332]);
  near(g.chainLength(top, paths), 562); near(g.chainLength(bottom, paths), 446.07, 0.01);
  near(paths[bottom[0]].length, 120); near(paths[bottom[1]].length, 108.93, 0.01); near(paths[bottom[2]].length, 217.14, 0.01);
});
test('straight and orthogonal d strings, exact lengths and endpoints', () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 100 };
  const straight = g.buildPath({ pathType: 'straight' }, a, b), orthogonal = g.buildPath({ pathType: 'orthogonal' }, a, b);
  assert.equal(straight.d, 'M 0,0 L 100,100'); assert.equal(orthogonal.d, 'M 0,0 L 50,0 L 50,100 L 100,100');
  near(straight.length, Math.sqrt(20000)); assert.equal(orthogonal.length, 200);
  assert.deepEqual(orthogonal.pointAt(75), { x: 50, y: 25 });
  for (const p of [straight, orthogonal]) { assert.deepEqual(p.pointAt(0), a); assert.deepEqual(p.pointAt(p.length), b); assert.deepEqual(p.pointAt(-5), a); }
});
test('cubic LUT, loop d strings and positive-left offset convention', () => {
  const a = { x: 0, y: 0 }, b = { x: 100, y: 0 };
  const straightCurve = g.buildPath({ pathType: 'curved' }, a, b);
  assert.equal(straightCurve.d, 'M 0,0 C 48,0 52,0 100,0'); near(straightCurve.length, 100);
  const positive = g.buildPath({ pathType: 'curved', curveOffset: 20 }, a, b);
  assert.equal(positive.d, 'M 0,0 C 48,20 52,20 100,0');
  near(positive.pointAt(positive.length / 2).y, 15, 0.001);
  const reverse = g.buildPath({ pathType: 'curved', curveOffset: 20 }, b, a);
  assert.equal(reverse.d, 'M 100,0 C 52,-20 48,-20 0,0');
  const loop = g.buildPath({ pathType: 'curved', loop: { side: 'top', size: 60 } }, a, a);
  assert.equal(loop.d, 'M 0,0 C -45,-80 57,-80 12,0'); assert.ok(loop.length > 12);
  near(loop.pointAt(loop.length / 2).y, -60, 0.001);
  const loopXs = loop.segments.flatMap(s => [s.from.x, s.to.x]);
  assert.ok(Math.max(...loopXs) - Math.min(...loopXs) > 30, 'loop must have visible lateral spread');
  assert.deepEqual(loop.pointAt(0), a); assert.deepEqual(loop.pointAt(loop.length), { x: 12, y: 0 });
  assert.equal(loop.segments.length, 256);
});
test('waypoints, zero-length segments and metric lookups remain finite', () => {
  const p = g.buildPath({ pathType: 'orthogonal', waypoints: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }, { x: 0, y: 0 }, { x: 10, y: 10 });
  assert.equal(p.length, 20); assert.deepEqual(p.pointAt(10), { x: 10, y: 0 });
  assert.throws(() => p.pointAt(NaN), /finite/);
  const metrics = g.createPathMetrics(scene); assert.equal(metrics.length('e-host-client'), 115); assert.throws(() => metrics.length('absent'), /Unknown edge/);
});
