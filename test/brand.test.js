'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { schema, validateScene, canonicalizeBrandUrl } = require('../src/schema.js');
const { normalizeScene } = require('../src/normalize-scene.js');
const { openPage } = require('../src/capture/capture-frames.js');
const { rootPath } = require('../src/paths.js');
const { applyBrand, parseArgs, isTrackedPath } = require('../scripts/apply-brand.js');
const themes = require('../src/renderer/themes.js');
const input = () => structuredClone(require('./fixtures/mindmap-4b-1l-url.json'));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('URL canonicalization rejects credentials, non-LinkedIn hosts, paths and query/fragment', () => {
  assert.equal(canonicalizeBrandUrl('https://linkedin.com/in/example/'), 'https://www.linkedin.com/in/example');
  assert.equal(canonicalizeBrandUrl('https://www.linkedin.com/company/example/'), 'https://www.linkedin.com/company/example');
  for (const url of ['http://linkedin.com/in/example', 'https://linkedin.com.evil.test/in/example', 'https://user:pass@linkedin.com/in/example', 'https://linkedin.com/in/example?q=1', 'https://linkedin.com/in/example#', 'https://linkedin.com/in/example?', 'https://linkedin.com/in/a', 'https://linkedin.com/feed', 'https://linkedin.com:8443/in/example', 'https://linkedin.com/in/' + 'x'.repeat(80)]) assert.throws(() => canonicalizeBrandUrl(url), /Brand URL/);
});
test('url-footer forbids all other branding properties including explicit false', () => {
  for (const key of Object.keys(schema.properties.brand.properties).filter(k => !['style', 'url'].includes(k))) {
    const scene = input(); scene.brand[key] = key === 'showSaveIcon' ? false : 'forbidden';
    assert.equal(validateScene(scene).valid, false, key);
  }
  const missing = input(); delete missing.brand.url; assert.equal(validateScene(missing).valid, false);
});
function luminance(hex) {
  return hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
test('footer is one 16px text/tspan, fits 736px and has 4.5 contrast on all themes', { timeout: 120000 }, async () => {
  for (const theme of Object.keys(themes.themes)) {
    const raw = input(); raw.theme = theme; raw.brand.url = 'https://www.linkedin.com/in/' + 'i'.repeat(72 - 'https://www.linkedin.com/in/'.length);
    const scene = normalizeScene(raw), session = await openPage(scene);
    try {
      const result = await session.page.evaluate(() => {
        const layer = document.querySelector('#layer-brand'), text = layer.querySelector('text'), bar = layer.querySelector('rect.brand-bar');
        return { texts: layer.querySelectorAll('text').length, spans: text.querySelectorAll('tspan').length, text: text.textContent, size: text.getAttribute('font-size'), weight: text.getAttribute('font-weight'), width: text.getComputedTextLength(), x: text.getAttribute('x'), y: text.getAttribute('y'), anchor: text.getAttribute('text-anchor'), barY: bar.getAttribute('y'), barH: bar.getAttribute('height'), fill: text.getAttribute('fill'), background: bar.getAttribute('fill') };
      });
      assert.equal(result.texts, 1); assert.equal(result.spans, 1); assert.equal(result.text, raw.brand.url);
      assert.equal(result.size, '16'); assert.equal(result.weight, '600'); assert.ok(result.width <= 736, String(result.width));
      assert.equal(result.x, '400'); assert.equal(result.y, '1076'); assert.equal(result.anchor, 'middle');
      assert.equal(result.barY, '1040'); assert.equal(result.barH, '60');
      const a = luminance(result.fill), b = luminance(result.background);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, theme);
    } finally { await session.close(); }
  }
});
test('apply-brand requires explicit targets, refuses tracked paths, copies and preserves bytes', async () => {
  assert.throws(() => parseArgs([]), /Explicit/);
  for (const directory of ['scenes', 'test', 'docs/examples']) assert.equal(isTrackedPath(rootPath(directory, 'example.json')), true);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-brand-'));
  const source = rootPath('scenes/mcp-vs-skills.json'), originalHash = hash(source);
  const config = path.join(temp, 'config.json'); fs.writeFileSync(config, JSON.stringify({ brand: { url: 'https://linkedin.com/in/example/' } }));
  const refused = spawnSync(process.execPath, [rootPath('scripts/apply-brand.js'), source, '--config', config], { shell: false, encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 2); assert.match(refused.stderr, /Refusing tracked path/); assert.equal(hash(source), originalHash);
  const report = await applyBrand({ targets: [source], config, out: temp });
  const copy = path.join(temp, path.basename(source)); assert.equal(report.changed.length, 1); assert.equal(hash(source), originalHash);
  assert.deepEqual(JSON.parse(fs.readFileSync(copy)).brand, { style: 'url-footer', url: 'https://www.linkedin.com/in/example' });
  const before = hash(copy); const again = await applyBrand({ targets: [copy], config });
  assert.equal(again.unchanged.length, 1); assert.equal(hash(copy), before);
  fs.writeFileSync(config, JSON.stringify({ brand: { url: 'https://evil.test/in/example' } }));
  await assert.rejects(applyBrand({ targets: [copy], config }), /Brand URL/); assert.equal(hash(copy), before);
});
test('apply-brand keeps indentation, newline, property order, skip/force and dry-run behavior', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-brand-format-'));
  const source = path.join(temp, 'scene.json'), config = path.join(temp, 'config.json');
  const scene = structuredClone(require('../scenes/mcp-vs-skills.json')); delete scene.brand;
  fs.writeFileSync(source, JSON.stringify(scene, null, '\t').replace(/\n/g, '\r\n') + '\r\n');
  fs.writeFileSync(config, JSON.stringify({ brand: { url: 'https://linkedin.com/in/example/' } }));
  const before = hash(source);
  assert.equal((await applyBrand({ targets: [source], config, 'dry-run': true })).changed.length, 1); assert.equal(hash(source), before);
  await applyBrand({ targets: [source], config });
  const output = fs.readFileSync(source, 'utf8'), keys = Object.keys(JSON.parse(output));
  assert.match(output, /\r\n\t"/); assert.ok(output.endsWith('\r\n')); assert.equal(keys.indexOf('brand'), keys.indexOf('title') + 1);
  const other = JSON.parse(output); other.brand = { style: 'corner', url: 'example' }; fs.writeFileSync(source, JSON.stringify(other));
  assert.equal((await applyBrand({ targets: [source], config })).skipped.length, 1);
  assert.equal((await applyBrand({ targets: [source], config, force: true })).changed.length, 1);
  fs.writeFileSync(config, '{}'); const current = hash(source);
  await assert.rejects(applyBrand({ targets: [source], config }), /brand.url/); assert.equal(hash(source), current);
});
