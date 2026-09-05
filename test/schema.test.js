'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { rootPath } = require('../src/paths.js');
const { validate, validateScene } = require('../src/schema.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const example = () => JSON.parse(fs.readFileSync(rootPath('scenes/mcp-vs-skills.json')));
const failure = (scene, pattern) => { const result = validateScene(scene); assert.equal(result.valid, false); assert.match(JSON.stringify(result.errors), pattern); };
test('Ajv 2020 discriminator applies branch defaults without mutating other branches', () => {
  const s = example(); s.timeline.animations = [{ kind: 'marching-dash', edgeIds: ['e-host-client'] }];
  assert.equal(validate(s), true, JSON.stringify(validate.errors));
  assert.equal(s.timeline.animations[0].dash, 8); assert.equal(s.timeline.animations[0].gap, 8);
  assert.equal(s.timeline.animations[0].speedPxPerSec, 50); assert.equal(s.timeline.animations[0].count, undefined);
});
test('unknown keys and unsupported fps fail structural validation', () => {
  let s = example(); s.timeline.animations[1].unknown = true; failure(s, /additional properties/);
  s = example(); s.timeline.fps = 1000 / 30; failure(s, /constant|integer/);
});
test('all three input fixtures validate', () => {
  for (const id of ['mcp-vs-skills', 'oauth-code-flow', 'solid-before-after']) {
    const result = validateScene(JSON.parse(fs.readFileSync(rootPath('scenes', id + '.json'))));
    assert.equal(result.valid, true, id + ': ' + JSON.stringify(result.errors));
  }
});
test('self-loop requires loop or two waypoints', () => {
  const s = example(); s.edges[0].to = s.edges[0].from; failure(s, /Self-loop/);
  s.edges[0].loop = { side: 'top', size: 60 }; assert.equal(validate(s), true, JSON.stringify(validate.errors));
});
test('ids share a namespace and references have the appropriate type', () => {
  let s = example(); s.annotations[0].id = s.nodes[0].id; failure(s, /Duplicate global id/);
  s = example(); s.timeline.animations[1].edgeIds = ['mcp-host']; failure(s, /Unresolved reference/);
  s = example(); s.edges[0].to = 'absent'; failure(s, /Unresolved reference/);
  s = example(); s.nodes[0].icon.name = 'not-an-icon'; failure(s, /Unknown icon/);
  s = example(); s.nodes[0].icon.name = 'constructor'; failure(s, /Unknown icon/);
});
test('animation hints, targets and phase budgets are checked', () => {
  let s = example(); s.timeline.animations[1].speedPxPerSec = 100; failure(s, /Exactly one/);
  s = example(); s.timeline.animations[1].color = '#FFFFFF'; failure(s, /At most one/);
  s = example(); s.timeline.durationMs = 6000; s.timeline.animations = [{ kind: 'sequential-highlight', order: s.nodes.slice(0, 7).map(n => n.id), dwellMs: 900 }]; failure(s, /dwellMs/);
  s = example(); s.timeline.animations.push({ kind: 'typing', targetId: 'a-client', text: 'typing', startMs: 3000, durationMs: 1000 }); failure(s, /exceeds loop/);
  s = example(); s.timeline.animations.push({ kind: 'typing', targetId: 'a-client', mirrorTargetId: 'e-host-client', text: 'typing', startMs: 0, durationMs: 1000 }); failure(s, /Typing target/);
  s = example(); s.timeline.animations = [{ kind: 'reveal', targetIds: ['mcp-host'], startMs: 0, durationMs: 1000 }]; failure(s, /ambient/);
});
test('pulse 1500 on 4000 normalizes to three cycles with a rounding warning', () => {
  const s = example(); s.timeline.animations = [{ kind: 'pulse', nodeIds: ['mcp-host'], periodMs: 1500 }];
  const n = normalizeScene(s); assert.equal(n.timeline.animations[0].cycles, 3); assert.equal(n.timeline.animations[0].effectivePeriodMs, 4000 / 3); assert.match(n.warnings.join(), /rounded/);
});
test('geometry rejects out-of-zone boxes, overlap, overflow and invalid annotation fields', () => {
  let s = example(); s.nodes[0].x = 0; failure(s, /content zone/);
  s = example(); s.nodes[1].x = 100; failure(s, /Overlapping nodes/);
  s = example(); s.annotations[0].x = 55; s.annotations[0].y = 180; failure(s, /intersects node/);
  s = example(); s.nodes[0].h = 20; failure(s, /label height/);
  s = example(); delete s.annotations[0].x; failure(s, /requires x/);
  s = example(); s.layout.dividerY = s.canvas.height + 10; failure(s, /Divider/);
  s = example(); s.nodes[0].y = 110; s.annotations.push({ id: 'attached-badge', kind: 'badge', number: 1, attachTo: 'mcp-host' }); failure(s, /content zone/);
});
test('badge attachment exemption and no-footer geometry', () => {
  const s = example(); s.brand.style = 'none'; s.annotations.push({ id: 'checkmark', kind: 'check', attachTo: 'mcp-host', x: 60, y: 190 });
  s.nodes.push({ id: 'footer-node', label: 'Footer', x: 40, y: 945, w: 150, h: 50, shape: 'rect' });
  assert.equal(validate(s), true, JSON.stringify(validate.errors));
});
test('normalization is deterministic, leaves input untouched and matches frozen fixture', () => {
  const s = example(), before = structuredClone(s), actual = normalizeScene(s);
  assert.deepEqual(s, before); assert.deepEqual(normalizeScene(s), actual);
  assert.deepEqual(actual, JSON.parse(fs.readFileSync(rootPath('test/fixtures/mcp-vs-skills.normalized.json'))));
  assert.deepEqual(actual.timeline.grids, { '40': 100, '50': 80 });
  assert.deepEqual(actual.layout.sections.map(s => [s.y, s.h]), [[110, 390], [500, 500]]);
  assert.equal(actual.timeline.animations[0].cycles, 12);
  assert.equal(actual.timeline.animations[1].travelMs, 2000);
  assert.deepEqual(actual.timeline.animations[1].offsetsMs, [0, 1000]);
  assert.equal(actual.timeline.animations[1].effectiveSpeedPxPerSec, 154.5);
  const original = JSON.parse(fs.readFileSync(rootPath('test/fixtures/mcp-vs-skills.original.json')));
  assert.equal(normalizeScene(original).timeline.animations[1].effectiveSpeedPxPerSec, 281);
});
test('cut phases, sequential starts and forced dashed paths carry normalized metadata', () => {
  const s = example(); s.edges[0].dashed = false;
  s.timeline.animations.push({ kind: 'typing', targetId: 'a-client', text: 'hello', startMs: 3000, durationMs: 1000, loopBehavior: 'cut' });
  s.timeline.animations.push({ kind: 'sequential-highlight', order: ['mcp-host', 'mcp-client'] });
  const n = normalizeScene(s); assert.equal(n.edges[0].dashed, true);
  assert.equal(n.timeline.animations[3].exitMs, 0); assert.equal(n.timeline.animations[3].holdMs, 0); assert.equal(n.timeline.loopSeam, 'cut');
  assert.deepEqual(n.timeline.animations[4].stepStartsMs, [0, 2000]);
});
