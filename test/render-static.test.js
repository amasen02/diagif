'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { chromium } = require('playwright');
const { rootPath } = require('../src/paths.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const { buildPageHtml } = require('../src/capture/page-source.js');
const svg = require('../src/renderer/svg-builder.js');
const themes = require('../src/renderer/themes.js');
const icons = require('../src/renderer/icons.js');
const edges = require('../src/renderer/edges.js');
const { tokenize } = require('../src/renderer/code-tokens.js');
const { render } = require('../src/renderer/render-static.js');
const fixtures = ['mcp-vs-skills', 'oauth-code-flow', 'solid-before-after'];
const scene = id => normalizeScene(JSON.parse(fs.readFileSync(rootPath('scenes', id + '.json'), 'utf8')));
const ctx = { measureText: svg.estimator };
test('SVG serialization escapes text and attributes, formats numbers, and rejects non-finite coordinates', () => {
  assert.equal(svg.serialize(svg.el('text', { x: 1.2345, title: '"<&' }, '<script>&')), '<text x="1.23" title="&quot;&lt;&amp;">&lt;script&gt;&amp;</text>');
  assert.throws(() => svg.serialize(svg.el('rect', { x: NaN })), /Non-finite/);
});
test('wrapText greedily wraps, hard breaks long tokens, and preserves paragraph boundaries', () => {
  const font = { size: 9 };
  const lines = svg.wrapText('a'.repeat(40), 106, font, ctx);
  assert.deepEqual(lines, ['a'.repeat(20), 'a'.repeat(20)]);
  assert.ok(lines.every(line => svg.estimator(line, font) <= 106));
  assert.deepEqual(svg.wrapText('a'.repeat(40), 106, { size: 16 }, ctx), ['a'.repeat(11), 'a'.repeat(11), 'a'.repeat(11), 'a'.repeat(7)]);
  assert.deepEqual(svg.wrapText('hello world\n\nend', 55, { size: 16 }, ctx), ['hello', 'world', '', 'end']);
  assert.deepEqual(svg.wrapText('😀'.repeat(6), 20, { size: 16 }, ctx), ['😀😀', '😀😀', '😀😀']);
  assert.deepEqual(svg.wrapText('abc def', 6, { size: 10 }, { measureText: text => text.length }), ['abc', 'def']);
});
test('all five themes expose complete color and font roles', () => {
  for (const theme of Object.values(themes.themes)) {
    for (const key of ['primary', 'secondary', 'neutral', 'cyan', 'mint', 'orange', 'magenta', 'danger', 'success']) for (const token of ['fill', 'stroke', 'text', 'soft']) assert.match(theme[key][token], /^#[0-9a-f]{6}$/i);
    assert.equal(Object.keys(theme.fonts).length, 7);
  }
  assert.throws(() => themes.get('missing'), /Unknown theme/);
});
test('icons preserve branded colors, support inlined art and reject unknown names', () => {
  const brand = svg.serialize(icons.render({ source: 'brand', name: 'slack' }, 1, 2, '#000000'));
  assert.match(brand, /#4A154B/); assert.match(brand, /viewBox="0 0 24 24"/);
  assert.match(svg.serialize(icons.render({ source: 'art', name: 'logo' }, 0, 0, '#000000', { assets: { 'art:logo': 'data:image/png;base64,AA==' } })), /href="data:image\/png/);
  assert.throws(() => icons.resolve({ name: 'missing' }), /Unknown icon/);
  assert.throws(() => icons.resolve({ source: 'art', name: 'missing' }), /Unknown art/);
});
test('code tokens preserve exact source and distinguish strings, comments, keywords, numbers', () => {
  const samples = { ts: 'const n = 42; // "comment"', js: 'return "a<>&";', sql: "SELECT 'from' FROM users -- 123", python: 'return 3 # note', yaml: 'ok: true # note', json: '{"ok": true, "count": 3}', bash: 'echo "hello" # note', text: '<ordinary>' };
  for (const [language, source] of Object.entries(samples)) assert.equal(tokenize(language, source).map(t => t.text).join(''), source);
  assert.deepEqual(tokenize('ts', samples.ts).filter(t => t.type !== 'plain').map(t => t.type), ['kw', 'num', 'cmt']);
  assert.equal(tokenize('sql', "'SELECT -- nope'")[0].type, 'str');
  assert.throws(() => tokenize('unknown', ''), /Unknown code language/);
});
test('render is deterministic, does not mutate a frozen input, and preserves the animation contract', () => {
  const s = scene('mcp-vs-skills');
  const freeze = obj => { if (obj && typeof obj === 'object') { Object.values(obj).forEach(freeze); Object.freeze(obj); } }; freeze(s);
  const result = render(s, ctx);
  assert.deepEqual(render(s, ctx), result);
  assert.equal((result.svgString.match(/class="edge-path"/g) || []).length, s.edges.length);
  assert.equal((result.svgString.match(/class="edge-tip"/g) || []).length, s.edges.length);
  assert.match(result.svgString, /fill="context-stroke"/);
  assert.match(result.svgString, /class="section-header chip-header"/);
  assert.doesNotMatch(result.svgString, /class="brand-bar"/);
  const branded = { ...s, brand: { style: 'bar', name: 'Example', url: 'example.com', tagline: 'Sample footer' } };
  assert.match(render(branded, ctx).svgString, /class="brand-bar" x="0" y="940"/);
  assert.ok(result.svgString.indexOf('class="node-shadow"') < result.svgString.indexOf('class="node-shape"'));
});
test('arrowless edges omit the terminal segment; fallback markers use resolved colors', () => {
  const s = scene('mcp-vs-skills'); s.edges[0].arrow = false;
  const output = render(s, { ...ctx, markerMode: 'per-color' }).svgString;
  assert.equal((output.match(/class="edge-tip"/g) || []).length, s.edges.length - 1);
  assert.doesNotMatch(output, /context-stroke/);
  assert.match(output, /id="arrow-62d2e8"/);
  const g = { length: 100, pointAt: n => ({ x: n, y: 20 }), segments: [] };
  const point = edges.labelPoint({ from: 'a', to: 'b', label: { t: 0.5, side: 'left' } }, g, []);
  assert.deepEqual(point, { x: 50, y: 30 });
});
test('owned UMD files load verbatim in manifest order without Node or DOM', () => {
  const sandbox = {}; vm.createContext(sandbox);
  const manifest = require('../src/renderer/manifest.json');
  for (const name of manifest.slice(0, manifest.indexOf('render-static') + 1)) vm.runInContext(fs.readFileSync(rootPath('src/renderer', name + '.js'), 'utf8'), sandbox);
  for (const name of ['themes', 'icons', 'svgBuilder', 'codeTokens', 'edges', 'layout', 'renderStatic']) assert.ok(sandbox.TechGif[name], name);
  const s = scene('mcp-vs-skills');
  assert.equal(sandbox.TechGif.renderStatic.render(s, ctx).svgString, render(s, ctx).svgString);
});
let browser;
test.before(async () => { browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser?.close(); });
async function browserRender(s) {
  const page = await browser.newPage({ viewport: { width: 800, height: s.canvas.height } });
  await page.setContent(buildPageHtml());
  await page.evaluate(async () => { await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready; });
  const result = await page.evaluate(s => {
    const rendered = TechGif.renderStatic.render(s, { measureText: __TECH_GIF__.measureText, iconData: TechGif.iconData });
    document.querySelector('#root').innerHTML = rendered.svgString;
    const xml = new DOMParser().parseFromString(rendered.svgString, 'image/svg+xml');
    const errors = [...xml.querySelectorAll('parsererror')].map(e => e.textContent);
    for (const group of document.querySelectorAll('g.node-label')) {
      const n = s.nodes.find(n => n.id === group.getAttribute('data-node-id')), b = group.getBBox();
      if (b.x < n.x || b.y < n.y || b.x + b.width > n.x + n.w || b.y + b.height > n.y + n.h) errors.push(n.id + ': label outside node ' + JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height }));
    }
    for (const managed of document.querySelectorAll('[data-node-id],[data-edge-id],[data-reveal-id]')) for (const attr of ['transform', 'opacity', 'style', 'stroke-dashoffset']) if (managed.hasAttribute(attr)) errors.push('Reserved attribute: ' + attr);
    const paths = TechGif.pathGeometry.buildScenePaths(s);
    for (const body of document.querySelectorAll('path.edge-path')) {
      const ours = paths[body.getAttribute('data-edge-id')].length;
      if (Math.abs(body.getTotalLength() - ours) / ours >= 0.005) errors.push('Geometry mismatch');
    }
    return { errors, svgString: rendered.svgString };
  }, s);
  return { page, result };
}
test('three frozen scenes render valid SVG with loaded-font labels inside their nodes', async () => {
  fs.mkdirSync(rootPath('work/static-review'), { recursive: true });
  for (const id of fixtures) {
    const { page, result } = await browserRender(scene(id));
    try {
      assert.deepEqual(result.errors, [], id);
      await page.screenshot({ path: rootPath('work/static-review', id + '.png') });
    } finally { await page.close(); }
  }
});
test('every node shape and elevation render without label overflow, including rotated labels', async () => {
  const shapes = ['rounded-rect', 'rect', 'pill', 'circle', 'database', 'panel', 'document', 'pipe', 'window', 'card', 'step'];
  const s = scene('mcp-vs-skills'); s.layout = { kind: 'freeform' }; s.annotations = []; s.edges = [];
  s.nodes = shapes.map((shape, i) => ({ id: 'shape-' + i, shape, label: 'Node', x: 60 + i % 3 * 240, y: 160 + Math.floor(i / 3) * 175, w: 170, h: 120, badge: i + 1, icon: { name: 'server', source: 'line', size: 24 }, style: { elevation: ['hard', 'soft', 'glow', 'none'][i % 4] }, labelRotate: i === 1 ? -90 : 0 }));
  const { page, result } = await browserRender(s);
  try { assert.deepEqual(result.errors, []); } finally { await page.close(); }
});
test('layout variants, titles, tables and all brand treatments produce valid XML', async () => {
  for (const style of ['bar', 'block', 'creator', 'corner', 'none']) {
    const s = scene('solid-before-after'); s.brand = { style, name: 'TECH SYSTEMS', url: 'example.test', socials: [{ network: 'linkedin', handle: '@author' }], showSaveIcon: true }; // sanitize-allow: neutral brand fixture matches external denylist
    s.title.accentWords = [{ word: 'One', colorRole: 'cyan' }]; s.title.chipWords = [{ word: 'Reason' }]; s.title.strikeWords = ['Change'];
    s.layout = { kind: 'split-columns', columns: [{ id: 'col-a', header: 'Policy', x: 35, y: 170, w: 330, h: 700 }, { id: 'col-b', header: 'Delivery', x: 420, y: 170, w: 340, h: 700, innerPanel: { x: 440, y: 200, w: 300, h: 80 } }] };
    s.annotations = [{ id: 'table', kind: 'table', x: 340, y: 350, w: 320, header: ['Key', 'Value'], rows: [['A', '<safe>']] }];
    const { page, result } = await browserRender(s);
    try { assert.deepEqual(result.errors, []); assert.doesNotMatch(result.svgString, /<safe>/); } finally { await page.close(); }
  }
});
test('measured title runs preserve spaces and edge badges do not cover label pills', async () => {
  const flagship = await browserRender(scene('mcp-vs-skills'));
  try {
    const gap = await flagship.page.evaluate(() => {
      const runs = [...document.querySelectorAll('.title-text')];
      const middle = runs.find(t => t.textContent.includes('vs')), skills = runs.find(t => t.textContent === 'Skills');
      const b = middle.getBBox();
      return Number(skills.getAttribute('x')) - b.x - b.width;
    });
    assert.ok(gap >= -0.2 && gap < 3, 'Space is preserved in the previous run without overlap: ' + gap);
  } finally { await flagship.page.close(); }
  const oauth = await browserRender(scene('oauth-code-flow'));
  try {
    const overlaps = await oauth.page.evaluate(() => ['authorize', 'exchange'].filter((id, index) => {
      const pill = document.querySelector('g.edge[data-edge-id="' + id + '"] .edge-label rect').getBBox();
      const circle = document.querySelector('[data-annotation-id="' + (index ? 'step-token' : 'step-auth') + '"] circle').getBBox();
      return pill.x < circle.x + circle.width && pill.x + pill.width > circle.x && pill.y < circle.y + circle.height && pill.y + pill.height > circle.y;
    }));
    assert.deepEqual(overlaps, []);
  } finally { await oauth.page.close(); }
});
test('preview command writes standalone SVG and HTML with bundled fonts and no external requests', async () => {
  const { pathToFileURL } = require('node:url');
  const result = await require('../src/commands/preview-svg.js').run([rootPath('scenes/oauth-code-flow.json')]);
  assert.equal(result.ok, true);
  for (const file of [result.results[0].svgPath, result.results[0].htmlPath]) {
    const page = await browser.newPage(), requests = [], errors = [];
    page.on('request', r => requests.push(r.url())); page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(pathToFileURL(file).href);
      const details = await page.evaluate(async () => {
        await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready;
        return { fonts: [...document.fonts].map(f => f.status), scene: document.querySelector('svg#scene')?.getAttribute('data-scene-id'), parserErrors: document.querySelectorAll('parsererror').length };
      });
      assert.equal(details.scene, 'oauth-code-flow'); assert.equal(details.parserErrors, 0);
      assert.equal(details.fonts.length, 8); assert.ok(details.fonts.every(status => status === 'loaded'));
      assert.deepEqual(errors, []); assert.ok(requests.every(url => url === pathToFileURL(file).href || url.startsWith('data:')));
    } finally { await page.close(); }
  }
});


test('label pills on a 32px edge clear both node boxes and retain their text', () => {
  for (const vertical of [false, true]) for (const text of ['send', 'claim/read', 'match', 'same req.']) {
    const nodes = [{ id: 'a', x: 100, y: 200, w: 160, h: 84 }, { id: 'b', x: vertical ? 100 : 292, y: vertical ? 316 : 200, w: 160, h: 84 }];
    const edge = { id: 'short', from: 'a', to: 'b', fromAnchor: vertical ? 'bottom' : 'right', toAnchor: vertical ? 'top' : 'left', pathType: 'straight', label: { text }, colorRole: 'cyan' };
    const tree = edges.render(edge, { nodes, timeline: { animations: [] } }, themes.get('dark-teal'), ctx);
    const label = tree.children.find(n => n.attrs.class === 'edge-label'), pill = label.children.find(n => n.tag === 'rect').attrs;
    for (const node of nodes) assert.ok(pill.x + pill.width <= node.x || pill.x >= node.x + node.w || pill.y + pill.height <= node.y || pill.y >= node.y + node.h, text);
    assert.ok(svg.serialize(label).includes(text));
  }
});
