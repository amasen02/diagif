'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');
const Ajv = require('ajv/dist/2020');
const { rootPath } = require('../src/paths.js');
const { schema, validateScene, contentZone } = require('../src/schema.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const { materializeMindmap, crossesBox } = require('../src/renderer/layout.js');
const geometry = require('../src/renderer/path-geometry.js');
const { openPage, capture, sha256 } = require('../src/capture/capture-frames.js');
const { render } = require('../src/renderer/render-static.js');
const { encode, resolveReservedColors } = require('../src/encode/encode.js');
const { verify } = require('../src/quality/quality-gate.js');
const load = name => JSON.parse(fs.readFileSync(rootPath('test/fixtures', name)));
const authored = (n = 4, l = 1, brand = 'none') => load(`mindmap-${n}b-${l}l-${brand}.json`);
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
async function checkContract(svg, scene) {
  const page = await browser.newPage();
  try {
    const failures = await page.evaluate(({ svg, scene }) => {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml'), errors = [];
      const check = (condition, message) => { if (!condition) errors.push(message); };
      check(!doc.querySelector('parsererror'), 'valid XML');
      const root = doc.querySelector('svg#scene'); check(!!root, 'svg#scene');
      check(root?.getAttribute('data-scene-id') === scene.id, 'scene id');
      check(root?.getAttribute('viewBox') === '0 0 800 ' + scene.canvas.height, 'viewBox');
      check(root?.getAttribute('width') === '800' && root?.getAttribute('height') === String(scene.canvas.height), 'dimensions');
      check(!!doc.querySelector('defs'), 'defs');
      const layers = ['bg', 'sections', 'edges', 'particles', 'nodes', 'labels', 'annotations', 'title', 'brand'];
      check(JSON.stringify([...root.children].filter(e => e.id.startsWith('layer-')).map(e => e.id)) === JSON.stringify(layers.map(n => 'layer-' + n)), 'layer order');
      check(doc.querySelector('#layer-particles')?.children.length === 0, 'particles empty at mount');
      for (const n of scene.nodes) {
        const group = doc.querySelector('g.node[data-node-id="' + n.id + '"]'); check(!!group, 'node ' + n.id);
        check(group?.getAttribute('data-reveal-id') === n.id, 'node reveal id ' + n.id);
        check(Number(group?.getAttribute('data-cx')) === n.x + n.w / 2 && Number(group?.getAttribute('data-cy')) === n.y + n.h / 2, 'node center ' + n.id);
        check(!!group?.querySelector('.node-shape'), 'node shape ' + n.id);
        check(!!doc.querySelector('g.node-label[data-node-id="' + n.id + '"]'), 'node label ' + n.id);
        check(!!doc.querySelector('[data-text-id="' + n.id + '"][data-full-text]'), 'typing text ' + n.id);
      }
      for (const e of scene.edges) {
        const group = doc.querySelector('g.edge[data-edge-id="' + e.id + '"]'); check(!!group, 'edge ' + e.id);
        check(group?.getAttribute('data-reveal-id') === e.id, 'edge reveal id ' + e.id);
        const body = group?.querySelector('path.edge-path[data-edge-id="' + e.id + '"]'), tip = group?.querySelector('path.edge-tip[data-edge-id="' + e.id + '"]');
        check(!!body && !!tip, 'edge paths ' + e.id);
        check(!!group?.querySelector('.edge-label[data-edge-id="' + e.id + '"]'), 'edge label ' + e.id);
        check(body?.hasAttribute('stroke-dasharray') === !!e.dashed, 'static dash ' + e.id);
        check(!tip?.hasAttribute('stroke-dasharray'), 'tip never dashed ' + e.id);
        if (e.arrow !== false) check(!!tip?.getAttribute('marker-end'), 'tip marker ' + e.id);
      }
      for (const a of scene.annotations) check(!!doc.querySelector('g.annotation[data-annotation-id="' + a.id + '"][data-reveal-id="' + a.id + '"]'), 'annotation ' + a.id);
      for (const element of doc.querySelectorAll('[data-node-id], [data-edge-id], [data-reveal-id]')) for (const attribute of ['transform', 'opacity', 'style', 'stroke-dashoffset']) check(!element.hasAttribute(attribute), 'managed static ' + attribute);
      return errors;
    }, { svg, scene });
    assert.deepEqual(failures, []);
  } finally { await page.close(); }
}
test('raw mind-map schema accepts empty generated arrays and rejects authored geometry and invalid tree shapes', () => {
  const raw = new Ajv({ strict: true, discriminator: true }).compile(schema);
  assert.equal(raw(authored()), true, JSON.stringify(raw.errors));
  const invalid = [
    s => { s.canvas.height = 1000; }, s => { s.timeline.durationMs = 3800; },
    s => { s.nodes.push({}); }, s => { s.edges.push({}); }, s => { s.timeline.animations.push({}); },
    s => { delete s.layout.mindmap; }, s => { s.layout.mindmap.branches.pop(); },
    s => { s.layout.mindmap.branches.push(...structuredClone(s.layout.mindmap.branches), structuredClone(s.layout.mindmap.branches[0])); },
    s => { s.layout.mindmap.branches[0].leaves = []; }, s => { s.layout.mindmap.branches[0].leaves.push({}, {}); },
    s => { s.layout.mindmap.root.x = 320; }, s => { s.layout.mindmap.root.label = ' leading'; },
    s => { s.layout.mindmap.root.label = 'x'.repeat(27); }, s => { s.layout.mindmap.branches[0].label = 'x'.repeat(23); },
    s => { s.layout.mindmap.branches[0].leaves[0].label = 'x'.repeat(21); },
    s => { s.layout.mindmap.branches[0].colorRole = 'invented'; },
    s => { s.layout.mindmap.branches[0].id = '1bad'; }
  ];
  for (const change of invalid) { const s = authored(); change(s); assert.equal(raw(s), false, change.toString()); }
  const freeform = authored(); freeform.layout = { kind: 'freeform' }; assert.equal(raw(freeform), false);
});
test('validator rejects duplicate global IDs, generated edge collisions and labels exceeding two lines', () => {
  for (const change of [s => { s.layout.mindmap.branches[0].id = 'root'; }, s => { s.layout.mindmap.branches[0].leaves[0].id = 'mm-root-branch-1'; }, s => { s.layout.mindmap.branches[0].leaves[0].label = 'aaa\nbbb\nccc'; }]) {
    const s = authored(); change(s); assert.equal(validateScene(s).valid, false);
  }
});
test('standalone UMD loads and materializes without require', () => {
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(rootPath('src/renderer/layout.js'), 'utf8'), context);
  const s = authored(); context.TechGif.layout.materializeMindmap(s, contentZone(s)); assert.equal(s.nodes.length, 9);
  assert.throws(() => materializeMindmap(authored(), { x: 32, y: 110, w: 736, h: 100, bottom: 210 }), { code: 'MINDMAP_LAYOUT' });
  assert.equal(crossesBox({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 2, y: 0, w: 4, h: 4 }, 0), false);
  assert.equal(crossesBox({ x: 0, y: 2 }, { x: 10, y: 2 }, { x: 2, y: 0, w: 4, h: 4 }, 0), true);
});
for (const n of [4, 8]) for (const l of [1, 2]) for (const brand of ['none', 'url']) {
  test(`golden ${n} branches / ${l} leaves / ${brand}, geometry, idempotency and browser contract`, { timeout: 90000 }, async () => {
    const s = authored(n, l, brand), original = structuredClone(s);
    if (n === 8 && l === 2) {
      const result = validateScene(s);
      assert.equal(result.valid, false);
      assert.equal(result.errors[0].code, 'MINDMAP_LAYOUT');
      assert.deepEqual(result.errors, load(`mindmap-golden-${n}b-${l}l-${brand}.json`).errors);
      assert.throws(() => materializeMindmap(authored(n, l, brand), contentZone(s)), { code: 'MINDMAP_LAYOUT' });
      return;
    }
    const normalized = normalizeScene(s);
    assert.deepEqual(s, original); assert.deepEqual(normalized.warnings, []);
    const result = validateScene(s); assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.scene.nodes.length, 1 + n + n * l);
    assert.equal(JSON.stringify(s.layout.mindmap.placement, null, 2) + '\n', fs.readFileSync(rootPath('test/fixtures', `mindmap-golden-${n}b-${l}l-${brand}.json`), 'utf8'));
    const before = JSON.stringify(s); assert.equal(validateScene(s).valid, true); assert.equal(JSON.stringify(s), before);
    // A caller's persisted placement and generated arrays are never trusted.
    s.layout.mindmap.placement = { version: 999 }; s.nodes = [{ id: 'untrusted' }]; s.edges = []; s.timeline.animations = [];
    assert.equal(validateScene(s).valid, true); assert.equal(JSON.stringify(s), before);
    const zone = contentZone(s);
    for (const node of s.nodes) {
      assert.ok(node.x >= zone.x && node.y >= zone.y && node.x + node.w <= zone.x + zone.w && node.y + node.h <= zone.bottom);
      assert.ok([node.x, node.y, node.w, node.h].every(Number.isInteger)); assert.equal(node.w % 2, 0); assert.equal(node.h % 2, 0);
    }
    for (let i = 0; i < s.nodes.length; i++) for (let j = i + 1; j < s.nodes.length; j++) {
      const a = s.nodes[i], b = s.nodes[j];
      assert.ok(a.x + a.w + 12 <= b.x || b.x + b.w + 12 <= a.x || a.y + a.h + 12 <= b.y || b.y + b.h + 12 <= a.y);
    }
    for (const edge of s.edges) {
      assert.equal(edge.pathType, 'straight'); assert.equal(edge.fromAnchor, 'right'); assert.equal(edge.toAnchor, 'left'); assert.equal(edge.dashed, true); assert.equal(edge.arrow, true);
      const segment = geometry.forEdge(edge, s.nodes);
      for (const node of s.nodes.filter(node => ![edge.from, edge.to].includes(node.id))) for (const part of segment.segments) assert.equal(crossesBox(part.from, part.to, node, 0), false);
    }
    await checkContract(render(normalized).svgString, normalized);
    const session = await openPage(normalized);
    try {
      const measured = await session.page.evaluate(scene => {
        __TECH_GIF__.seek(0);
        return { halos: document.querySelectorAll('rect.mindmap-halo').length, nodes: scene.nodes.map(node => {
          const label = document.querySelector('g.node-label[data-node-id="' + node.id + '"]'), box = label.getBBox();
          return { id: node.id, spans: label.querySelectorAll('tspan').length, size: Number(label.querySelector('text').getAttribute('font-size')), opacity: getComputedStyle(label).opacity, inset: Math.min(box.x - node.x, box.y - node.y, node.x + node.w - box.x - box.width, node.y + node.h - box.y - box.height) };
        }) };
      }, normalized);
      assert.equal(measured.halos, n);
      const haloBounds = await session.page.evaluate(() => [...document.querySelectorAll('rect.mindmap-halo')].map(el => Object.fromEntries(['x', 'y', 'width', 'height', 'fill'].map(key => [key, el.getAttribute(key)]))));
      for (const [i, branch] of normalized.layout.mindmap.branches.entries()) {
        const ids = [branch.id, ...branch.leaves.map(l => l.id)], members = normalized.nodes.filter(n => ids.includes(n.id));
        const x = Math.min(...members.map(n => n.x)) - 16, y = Math.min(...members.map(n => n.y)) - 16;
        assert.deepEqual(haloBounds[i], { x: String(x), y: String(y), width: String(Math.max(...members.map(n => n.x + n.w)) + 16 - x), height: String(Math.max(...members.map(n => n.y + n.h)) + 16 - y), fill: haloBounds[i].fill });
        assert.match(haloBounds[i].fill, /^#[0-9a-f]{8}$/i);
      }
      for (const node of measured.nodes) { assert.equal(node.opacity, '1'); assert.ok(node.size >= (node.id === 'root' ? 20 : node.id.startsWith('branch') ? 17 : 15)); assert.ok(node.spans <= 2, node.id); assert.ok(node.inset >= 4, JSON.stringify(node)); }
      assert.equal(sha256(await session.screenshot(0)), sha256(await session.screenshot(normalized.timeline.durationMs)));
      const offset = await session.page.evaluate(() => { __TECH_GIF__.seek(1200); return Number(document.querySelector('.edge-path').getAttribute('stroke-dashoffset')); });
      assert.notEqual(offset, 0);
      assert.notEqual(sha256(await session.screenshot(0)), sha256(await session.screenshot(5000)));
    } finally { await session.close(); }
  });
}
test('authored order and every supported branch-count/duration schedule remain valid', () => {
  for (let D = 4000; D <= 8000; D += 200) for (const n of [4, 5, 6, 7, 8]) {
    const s = authored(8, 1, 'url'); s.timeline.durationMs = D; s.layout.mindmap.branches.length = n;
    const result = validateScene(s); assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(s.layout.mindmap.placement.items.filter(i => i.kind === 'branch').map(i => i.id), s.layout.mindmap.branches.map(b => b.id));
    assert.deepEqual(normalizeScene(s).warnings, []);
    assert.deepEqual(s.timeline.animations.map(a => a.kind), ['marching-dash', 'sequential-highlight']);
    assert.equal(s.timeline.animations[1].dwellMs, D / n);
    assert.deepEqual(s.timeline.animations[1].order, s.layout.mindmap.branches.map(b => b.id));
    assert.ok(s.timeline.animations.every(a => !Object.hasOwn(a, 'exitMs') && !Object.hasOwn(a, 'transitionMs')));
  }
});

test('materializer mixed leaf heights preserve row centers, 12px sibling gaps and fixed columns', () => {
  const s = authored(4, 2, 'url');
  s.layout.mindmap.branches[0].leaves[0].label = 'First\nSecond';
  // Exercise the sizing API directly: the authored schema disallows explicit
  // newlines, independently of the materializer's two-line height support.
  materializeMindmap(s, contentZone(s));
  const root = s.nodes[0], branch = s.nodes[1], [a, b] = s.nodes.slice(2, 4);
  assert.deepEqual([root.x, root.w, root.h, branch.x, branch.w, branch.h, a.x, a.w, a.h, b.h], [32, 200, 96, 280, 152, 84, 480, 200, 76, 64]);
  assert.equal(b.y - a.y - a.h, 12);
  assert.equal(branch.y + branch.h / 2, (a.y + b.y + b.h) / 2);
  const { top, cluster } = s.layout.mindmap.placement;
  assert.equal(root.y, Math.round((top + (cluster - root.h) / 2) / 16) * 16);
});

test('sparse rows form a centered compact cluster instead of spanning the canvas', () => {
  const s = authored(4, 1, 'url'); assert.equal(validateScene(s).valid, true);
  assert.deepEqual(s.nodes.filter(n => n.id.startsWith('branch')).map(n => n.y), [368, 480, 592, 704]);
  assert.equal(s.layout.mindmap.placement.pitch, 112);
  assert.equal(s.layout.mindmap.placement.cluster, 420);
  assert.equal(s.nodes[0].y, 528);
});
test('full 800x1100 Pillow mind-map render passes the unchanged quality gate', { timeout: 300000 }, async () => {
  const scene = normalizeScene(authored(8, 1, 'url'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-mindmap-render-'));
  const frames = await capture(scene, { workDir, stepMs: 40 });
  assert.equal(frames.framePaths.length, 150); assert.ok(new Set(frames.frameHashes).size > 1);
  assert.equal(sha256(fs.readFileSync(frames.framePaths[0])), sha256(fs.readFileSync(frames.seamPath)));
  const reservedColors = resolveReservedColors(scene), outPath = path.join(workDir, 'mindmap.gif');
  const encoded = await encode({ scene, framesDir: frames.framesDir, framePaths: frames.framePaths, stepMs: 40, outPath, encoder: 'pillow', reservedColors, rung: 0 });
  assert.equal(encoded.encoder, 'pillow');
  const quality = await verify({ gifPath: encoded.gifPath, framesDir: frames.framesDir, expectedWidth: 800, expectedHeight: 1100, expectedDurationMs: 6000, stepMs: 40, maxBytes: require('../config/defaults.json').caps.primaryMaxBytes, reservedColors, lossy: false });
  assert.deepEqual(quality.failures, []); assert.equal(quality.ok, true);
  assert.ok(fs.existsSync(outPath + '.contact.png'));
  console.log('Pillow mindmap evidence: ' + JSON.stringify({ workDir, bytes: encoded.bytes, failures: quality.failures, frames: frames.framePaths.length }));
});
