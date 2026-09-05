'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { rootPath } = require('../src/paths.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const { buildPageHtml } = require('../src/capture/page-source.js');
const { pythonCandidates, resolvePython } = require('../src/python.js');
const { verifyManifest, sha256 } = require('../scripts/fetch-fonts.js');
const fixture = fs.readFileSync(rootPath('test/fixtures/contract.svg'), 'utf8');
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
test('hand-written fixture satisfies the frozen DOM contract', async () => {
  const raw = JSON.parse(fixture.match(/<metadata id="fixture-scene">([\s\S]*?)<\/metadata>/)[1]);
  await checkContract(fixture, normalizeScene(raw));
});
test('renderStatic output satisfies the same contract', async t => {
  if (!fs.existsSync(rootPath('src/renderer/render-static.js'))) return t.skip('Phase 1 render-static module not loaded yet');
  const scene = normalizeScene(require('../scenes/mcp-vs-skills.json'));
  const nodeCtx = { measureText: (text, spec) => text.length * 0.58 * (spec?.size || spec?.fontSize || 16), iconData: require('../src/renderer/icon-data.js') };
  const output = require('../src/renderer/render-static.js').render(scene, nodeCtx);
  await checkContract(output.svgString, scene);
});
test('render page is self-contained, loads all font faces, and names missing modules', async () => {
  const html = buildPageHtml(); assert.ok(html.length > 1e6);
  assert.doesNotMatch(html, /\bsrc\s*=/i); assert.doesNotMatch(html.replace(/url\(data:[^)]*\)/g, ''), /url\(/i);
  assert.doesNotMatch(html, /<!--INJECT:/);
  const page = await browser.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push(r.url()));
  try {
    await page.setContent(html);
    const result = await page.evaluate(async () => {
      await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready;
      return { faces: [...document.fonts].map(f => ({ family: f.family, status: f.status, check: document.fonts.check('16px "' + f.family + '"') })), api: Object.keys(window.__TECH_GIF__), width: window.__TECH_GIF__.measureText('TECH GIF', { family: 'Inter', size: 16 }) };
    });
    assert.equal(result.faces.length, 8); assert.ok(result.faces.every(f => f.status === 'loaded' && f.check)); assert.ok(result.width > 20);
    assert.deepEqual(result.api.sort(), ['frameCount', 'measureText', 'mount', 'mountSvg', 'seek']);
    assert.deepEqual(errors, []); assert.ok(requests.every(url => url.startsWith('data:')));
    if (!fs.existsSync(rootPath('src/renderer/render-static.js'))) await assert.rejects(page.evaluate(() => window.__TECH_GIF__.mount({})), /module not loaded: renderStatic/);
  } finally { await page.close(); }
});
test('mountSvg self-checks geometry and exposes the sampling API', async () => {
  const scene = normalizeScene(JSON.parse(fixture.match(/<metadata id="fixture-scene">([\s\S]*?)<\/metadata>/)[1]));
  const page = await browser.newPage();
  try {
    await page.setContent(buildPageHtml());
    const result = await page.evaluate(({ svg, scene }) => {
      // Dependency doubles test only the Phase 0 glue; Phase 1 owns seek behavior.
      TechGif.timeline = {};
      TechGif.animations = { attach: (el, s, timeline, metrics) => ({ seek: t => { window.lastSeek = t; window.firstLength = metrics.length(s.edges[0].id); } }) };
      const mounted = __TECH_GIF__.mountSvg(svg, scene); __TECH_GIF__.seek(1200);
      return { mounted, frames40: __TECH_GIF__.frameCount(40), frames50: __TECH_GIF__.frameCount(50), lastSeek, firstLength };
    }, { svg: fixture, scene });
    assert.equal(result.mounted.geometrySelfCheck.length, 2); assert.ok(result.mounted.geometrySelfCheck.every(c => c.relErr < 0.005));
    assert.equal(result.frames40, 100); assert.equal(result.frames50, 80); assert.equal(result.lastSeek, 1200); assert.equal(result.firstLength, 115);
    await assert.rejects(page.evaluate(() => __TECH_GIF__.frameCount(30)), /Unsupported sampling grid/);
    await assert.rejects(page.evaluate(({ svg, scene }) => __TECH_GIF__.mountSvg(svg.replace('M 185,218 L 300,218', 'M 185,218 L 350,218'), scene), { svg: fixture, scene }), /Geometry self-check/);
  } finally { await page.close(); }
});
test('owned renderer modules also load in a clean browser UMD context', () => {
  const sandbox = {}; vm.createContext(sandbox);
  for (const name of ['path-geometry', 'icon-data', 'page-runtime']) vm.runInContext(fs.readFileSync(rootPath('src/renderer', name + '.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.TechGif.pathGeometry.buildPath, 'function');
  assert.throws(() => sandbox.TechGif.pageRuntime.mount({}), /module not loaded: renderStatic/);
});
test('asset manifests verify content hashes and Python avoids Windows python3', async () => {
  for (const directory of ['fonts', 'assets/icons']) {
    const manifest = JSON.parse(fs.readFileSync(rootPath(directory, 'manifest.json')));
    assert.ok(await verifyManifest(rootPath(directory), manifest) > 0);
    if (manifest.colorsSha256) assert.equal(sha256(fs.readFileSync(rootPath(directory, 'brands/colors.json'))), manifest.colorsSha256);
  }
  assert.deepEqual(pythonCandidates('win32', {}).map(c => c.command), ['py', 'python']);
  assert.deepEqual(pythonCandidates('win32', { TECH_GIFS_PYTHON: 'C:\\WindowsApps\\python3.exe' }).map(c => c.command), ['py', 'python']); // sanitize-allow: Windows Store path fixture
  assert.ok(Number((await resolvePython()).pillowVersion.split('.')[0]) >= 10);
});
