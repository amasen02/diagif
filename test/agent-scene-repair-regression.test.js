'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deterministicRepair } = require('../src/agent/scene-repair.js');
const { validateScene } = require('../src/schema.js');
const { claimsCover, carryClaims } = require('../src/agent/claims.js');
const { validateAndInspect } = require('../src/agent/scene-inspect.js');

function proposal() {
  return {
    id: 'repair-regression', canvas: { width: 800, height: 1000 }, theme: 'dark-teal', grain: false,
    title: { text: 'Repair mechanics', lines: ['Repair mechanics'], invented: ['must go'] },
    layout: { kind: 'freeform' },
    nodes: [
      { id: 'first', label: 'A label with several useful words', icon: { source: 'line', name: 'file-plus', size: 28 }, x: 16, y: 112, w: 180, h: 60, shape: 'rounded-rect' },
      { id: 'second', label: 'Second node', x: 100, y: 112, w: 180, h: 80, shape: 'rounded-rect' }
    ],
    edges: [{ id: 'flow', from: 'first', to: 'second', pathType: 'straight' }],
    timeline: { durationMs: 4000, fps: 25, loop: true, animations: [
      { kind: 'particle-flow', edgeIds: ['flow'], count: 2, cyclesPerLoop: 2, speedPxPerSec: 180, colorRole: 'cyan', color: '#00ffff' },
      { kind: 'pulse', nodeIds: ['first'], cyclesPerLoop: 2, periodMs: 2000 },
      { kind: 'particle-flow', edgeIds: ['flow'], count: 2 }
    ] },
    annotations: [], brand: { style: 'none' }, rootExtra: { invented: true }
  };
}

test('repair fixes structural, icon, animation, label, overlap, and zone failures in fixed order', () => {
  const scene = proposal();
  const trace = deterministicRepair(scene);
  const rules = trace.map(entry => entry.rule);
  assert.equal(validateScene(scene).valid, true, JSON.stringify(validateScene(scene).errors));
  assert.equal(scene.rootExtra, undefined);
  assert.equal(scene.title.invented, undefined);
  assert.equal(scene.title.lines[0], 'Repair mechanics', 'legal renderer hint is retained');
  assert.equal(scene.nodes[0].icon.name, 'box');
  assert.equal(scene.timeline.animations[0].speedPxPerSec, undefined);
  assert.equal(scene.timeline.animations[0].color, undefined);
  assert.equal(scene.timeline.animations[1].periodMs, undefined);
  assert.equal(scene.timeline.animations[2].cyclesPerLoop, 2);
  for (const expected of ['unknown-property', 'unknown-icon', 'animation-cardinality', 'label-overflow', 'node-overlap', 'out-of-zone']) assert.ok(rules.includes(expected), expected);
  assert.ok(trace.penalties.length >= 1);
  assert.ok(trace.penalties.every(({ before, after }) => after <= before));
  assert.ok(trace.every(entry => Object.hasOwn(entry, 'path') && Object.hasOwn(entry, 'old') && Object.hasOwn(entry, 'new')));
});

test('label shortening is a word-boundary edit of at least three words', () => {
  const scene = proposal();
  scene.nodes[0] = { ...scene.nodes[0], label: 'A label with many useful explanatory words', x: 32, y: 900, h: 80 };
  scene.nodes[1] = { ...scene.nodes[1], x: 500, y: 400 };
  delete scene.title.invented;
  const trace = deterministicRepair(scene);
  const rewrite = trace.find(entry => entry.path === '/nodes/0/label' && entry.rule === 'label-overflow');
  assert.ok(rewrite, JSON.stringify(trace));
  assert.ok(rewrite.new.split(/\s+/).length >= 3);
  assert.ok(!rewrite.new.endsWith('…'));
});

test('a distant brand icon falls back to the vendored line box icon', () => {
  const scene = proposal(); delete scene.title.invented;
  scene.nodes[0].icon = { source: 'brand', name: 'not-a-vendored-brand', size: 28 };
  deterministicRepair(scene);
  assert.equal(scene.nodes[0].icon.source, 'line');
  assert.equal(scene.nodes[0].icon.name, 'box');
});

test('label growth is capped at forty pixels across repair loops', () => {
  const scene = proposal(); delete scene.title.invented;
  scene.nodes[0] = { ...scene.nodes[0], label: 'ExtraordinaryHyperextendedToken useful', x: 32, y: 300, w: 80, h: 60,
    icon: { source: 'line', name: 'box', size: 96 } };
  scene.nodes[1] = { ...scene.nodes[1], x: 500, y: 400 };
  const trace = deterministicRepair(scene);
  assert.equal(scene.nodes[0].h, 100);
  assert.ok(trace.filter(entry => entry.path === '/nodes/0/h').every(entry => entry.new <= 100));
  assert.match(JSON.stringify(validateScene(scene).errors), /Estimated wrapped label height/);
});

test('malformed scene values remain validation errors instead of crashing repair', () => {
  const scene = proposal(); delete scene.title.invented;
  scene.nodes[0].label = 42;
  scene.annotations = [{ id: 'bad-note', kind: 'callout', text: 99, x: 32, y: 200, maxWidth: 120 }];
  assert.doesNotThrow(() => deterministicRepair(scene, { measureLines: value => value.split(/\s+/).length,
    zone: { x: 32, y: 110, w: 736, h: 890, bottom: 1000 }, validate: validateScene }));
  assert.equal(validateScene(scene).valid, false);
});

test('the four captured live proposals repair to valid, grounded scenes', () => {
  const fixtures = path.join(__dirname, 'fixtures', 'agent-real-proposals');
  const facts = JSON.parse(fs.readFileSync(path.join(fixtures, 'fact-sheet.json'), 'utf8'));
  for (const attempt of ['a1', 'a2', 'a3', 'a4']) {
    const proposal = JSON.parse(fs.readFileSync(path.join(fixtures, attempt + '.json'), 'utf8'));
    const scene = structuredClone(proposal.scene), trace = deterministicRepair(scene);
    const validation = validateScene(scene);
    assert.equal(validation.valid, true, attempt + ': ' + JSON.stringify(validation.errors));
    const coverage = claimsCover(scene, carryClaims(scene, proposal.claims, trace), facts);
    assert.equal(coverage.ok, true, attempt + ': ' + JSON.stringify(coverage.errors));
    assert.ok(trace.penalties.every(({ before, after }) => after <= before), attempt);
  }
});

test('captured critic-repair panel grows to the renderer text-stack inset', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'agent-real-proposals', 'captured-critic-repair.json');
  const captured = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const scene = structuredClone(captured.proposal.scene);
  scene.brand = { style: 'none' };
  const trace = deterministicRepair(scene);
  const panel = scene.nodes.find(node => node.id === 'retrieved-context');
  assert.ok(panel.h >= 96, JSON.stringify(trace));
  const inspection = await validateAndInspect(scene, { timeoutMs: 60000 });
  assert.equal(inspection.ok, true, JSON.stringify(inspection.errors));
});
