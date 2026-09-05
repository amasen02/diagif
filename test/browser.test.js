'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { rootPath } = require('../src/paths.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const { buildPreviewHtml } = require('../src/commands/preview.js');
const { openPage, readFixture, pngDimensions, sha256, identicalRanges, capture } = require('../src/capture/capture-frames.js');
const fixture = readFixture(rootPath('test/fixtures/contract.svg'));
const near = (a, b, epsilon = 1e-8) => assert.ok(Math.abs(a - b) <= epsilon, a + ' != ' + b);
function authored() { return JSON.parse(fixture.svgString.match(/<metadata id="fixture-scene">([\s\S]*?)<\/metadata>/)[1]); }
test('fixture mount, exact 0/1200/3960 attributes, backward seeks and deterministic pixels', { timeout: 90000 }, async () => {
  const session = await openPage(fixture.scene, { svgString: fixture.svgString });
  try {
    console.log('launch-arg probe: ' + JSON.stringify(session.launchArgProbe));
    assert.equal(session.launchArgProbe.passed, true);
    assert.equal(session.fonts.length, 8); assert.ok(session.fonts.every(f => f.status === 'loaded'));
    assert.equal(session.mountInfo.geometrySelfCheck.length, 2); assert.ok(session.mountInfo.geometrySelfCheck.every(c => c.relErr < 0.005));
    await session.page.evaluate(() => { SVGPathElement.prototype.getPointAtLength = () => { throw new Error('Particle runtime must use pathMetrics'); }; });
    const expectations = [
      [0, 0, [[185, 218, 0], [498, 241, 1]]],
      [1200, -57.6, [[498, 280.2, 1], [224.2, 218, 1]]],
      [3960, -190.08, [[547.16, 380, 0.25], [498, 233.16, 1]]]
    ];
    for (const [time, offset, particles] of expectations) {
      const result = await session.page.evaluate(t => {
        __TECH_GIF__.seek(t);
        return { offset: Number(document.querySelector('.edge-path').getAttribute('stroke-dashoffset')),
          particles: [...document.querySelectorAll('circle.particle')].map(p => ['cx', 'cy', 'opacity'].map(k => Number(p.getAttribute(k)))),
          tips: [...document.querySelectorAll('.edge-tip')].map(p => [p.getAttribute('stroke-dashoffset'), p.getAttribute('stroke-dasharray')]) };
      }, time);
      near(result.offset, offset); assert.deepEqual(result.tips, [[null, null], [null, null]]);
      particles.forEach((p, i) => p.forEach((n, j) => near(result.particles[i][j], n)));
    }
    const first = await session.screenshot(1200); await session.screenshot(3960); const again = await session.screenshot(1200);
    assert.deepEqual(pngDimensions(first), { width: 1600, height: 2000 }); assert.equal(sha256(first), sha256(again));
    assert.equal(sha256(await session.screenshot(0)), sha256(await session.screenshot(4000)));
    const baseline = await session.page.evaluate(() => { __TECH_GIF__.seek(1200); return document.querySelector('#scene').outerHTML; });
    await session.page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-node-id], [data-edge-id], [data-reveal-id], [data-text-id]')) for (const name of ['transform', 'opacity', 'style', 'stroke-dashoffset']) el.setAttribute(name, name === 'style' ? 'display:none' : name === 'transform' ? 'translate(9,9)' : '0.2');
      document.querySelectorAll('.edge-path').forEach(el => el.setAttribute('stroke-dasharray', '1 99'));
      document.querySelector('[data-text-id]').textContent = 'corrupted';
      document.querySelector('#layer-particles').append(document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
      __TECH_GIF__.seek(1200);
    });
    assert.equal(await session.page.locator('#scene').evaluate(el => el.outerHTML), baseline);
    await assert.rejects(session.page.evaluate(() => __TECH_GIF__.seek(NaN)), /finite/);
    await assert.rejects(session.page.evaluate(() => __TECH_GIF__.frameCount(30)), /Unsupported/);
    session.assertPage();
  } finally { await session.close(); }
});
test('pulse, highlight, typing, reveal, glow and trail DOM states reset completely', { timeout: 90000 }, async () => {
  const raw = authored();
  raw.timeline.animations.push(
    { kind: 'pulse', nodeIds: ['mcp-host'], cyclesPerLoop: 1, scale: 1.1 },
    { kind: 'sequential-highlight', order: ['mcp-client', 'mcp-server'], transitionMs: 200, scale: 1.06 },
    { kind: 'typing', targetId: 'mcp-host', mirrorTargetId: 'mcp-client', text: 'ABCDEFGH', startMs: 200, durationMs: 1000, exitMs: 400 },
    { kind: 'reveal', targetIds: ['mcp-server'], startMs: 200, durationMs: 1000, exitMs: 400, mode: 'fade-scale' }
  );
  raw.timeline.animations[1].glow = true; raw.timeline.animations[1].trail = 3;
  const session = await openPage(normalizeScene(raw), { svgString: fixture.svgString, stepMs: 50 });
  try {
    const state = await session.page.evaluate(() => {
      __TECH_GIF__.seek(700);
      const text = id => document.querySelector('[data-text-id="' + id + '"]').textContent;
      const node = id => document.querySelector('g.node[data-node-id="' + id + '"]');
      const n = node('mcp-server');
      return { typed: text('mcp-host'), mirror: text('mcp-client'), revealOpacity: Number(n.getAttribute('opacity')),
        revealTransform: n.getAttribute('transform'), labelTransform: document.querySelector('g.node-label[data-node-id="mcp-server"]').getAttribute('transform'),
        pulse: node('mcp-host').getAttribute('transform'), hostLabel: document.querySelector('g.node-label[data-node-id="mcp-host"]').getAttribute('transform'),
        glow: document.querySelectorAll('.particle-glow').length, trails: document.querySelectorAll('.particle-trail').length,
        activeWidth: Number(node('mcp-client').querySelector('.node-shape').getAttribute('stroke-width')),
        shadow: node('mcp-client').querySelector('.node-shadow').getAttribute('transform') };
    });
    assert.equal(state.typed, 'ABCDEFG'); assert.equal(state.mirror, 'ABCDEF'); near(state.revealOpacity, 0.875);
    assert.match(state.revealTransform, /scale\(0.9875\)/); assert.equal(state.revealTransform, state.labelTransform);
    assert.equal(state.pulse, state.hostLabel); assert.equal(state.glow, 2); assert.equal(state.trails, 6);
    assert.equal(state.activeWidth, 2); assert.equal(state.shadow, 'translate(2,2)');
    const exit = await session.page.evaluate(() => { __TECH_GIF__.seek(3800); return Number(document.querySelector('[data-text-id="mcp-host"]').getAttribute('opacity')); });
    near(exit, 0.875);
    const zero = await session.page.evaluate(() => { __TECH_GIF__.seek(0); return document.querySelector('#scene').outerHTML; });
    await session.page.evaluate(() => { __TECH_GIF__.seek(3000); __TECH_GIF__.seek(4000); });
    assert.equal(await session.page.locator('#scene').evaluate(el => el.outerHTML), zero);
    const reset = await session.page.evaluate(() => ({ text: document.querySelector('[data-text-id="mcp-host"]').textContent,
      opacity: Number(document.querySelector('g.node[data-node-id="mcp-server"]').getAttribute('opacity')),
      width: Number(document.querySelector('g.node[data-node-id="mcp-client"] .node-shape').getAttribute('stroke-width')),
      shadow: document.querySelector('g.node[data-node-id="mcp-client"] .node-shadow').getAttribute('transform') }));
    assert.deepEqual(reset, { text: '', opacity: 0, width: 1, shadow: null });
    session.assertPage();
  } finally { await session.close(); }
});
test('capture emits half-open frame list, seam proof, hashes and complete metadata', { timeout: 90000 }, async () => {
  // A short normalized fixture keeps this capture protocol test independent of encoding.
  const scene = structuredClone(fixture.scene); scene.timeline.durationMs = 200;
  scene.timeline.animations = [{ kind: 'pulse', nodeIds: ['mcp-host'], cyclesPerLoop: 1, scale: 1.1 }];
  const workDir = fs.mkdtempSync(rootPath('work/job-b-capture-'));
  const result = await capture(scene, { workDir, svgString: fixture.svgString, stepMs: 50 });
  assert.equal(result.framePaths.length, 4); assert.equal(result.frameHashes.length, 4);
  result.framePaths.forEach((file, i) => { assert.match(file, new RegExp('frame_' + String(i).padStart(4, '0') + '\\.png$')); assert.equal(sha256(fs.readFileSync(file)), result.frameHashes[i]); });
  assert.equal(sha256(fs.readFileSync(result.seamPath)), result.frameHashes[0]);
  assert.deepEqual([result.width, result.height], [1600, 2000]); assert.equal(result.playwrightVersion, '1.62.0');
  assert.equal(result.fonts.length, 8); assert.ok(result.browserVersion); assert.ok(result.os); assert.ok(result.launchArgProbe.passed);
  assert.deepEqual(identicalRanges(['a', 'a', 'b', 'c', 'c', 'c', 'd']), [[0, 1], [3, 5]]);
});
test('interactive preview mounts the fixture and scrubs without external requests', { timeout: 90000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => requests.push(r.url()));
    await page.setContent(buildPreviewHtml(fixture.scene, fixture.svgString, 50));
    const slider = page.getByRole('slider', { name: 'Animation time' }); await slider.waitFor();
    await slider.fill('1200');
    assert.equal(await page.locator('output').textContent(), '1200 ms');
    near(await page.locator('.edge-path').first().evaluate(el => Number(el.getAttribute('stroke-dashoffset'))), -57.6);
    assert.deepEqual(errors, []); assert.ok(requests.every(url => url.startsWith('data:')));
  } finally { await browser.close(); }
});
