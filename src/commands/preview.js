'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { parse, input } = require('./capture.js');
const { buildPageHtml } = require('../capture/page-source.js');
const { absolute, rootPath } = require('../paths.js');
const { frameCount } = require('../renderer/timeline.js');
const config = require('../../config/defaults.json');
function buildPreviewHtml(scene, svgString, stepMs = 40) {
  frameCount(scene.timeline.durationMs, stepMs);
  const payload = JSON.stringify({ scene, svgString, stepMs }).replace(/</g, '\\u003c');
  const script = `<script>
  (async function () {
    const { scene, svgString, stepMs } = ${payload};
    await Promise.all([...document.fonts].map(f => f.load())); await document.fonts.ready;
    if ([...document.fonts].some(f => f.status !== 'loaded')) throw new Error('Font fallback detected');
    document.documentElement.setAttribute('data-tech-gif-step-ms', String(stepMs));
    if (svgString === undefined) __TECH_GIF__.mount(scene); else __TECH_GIF__.mountSvg(svgString, scene);
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;bottom:0;left:0;width:800px;padding:10px;box-sizing:border-box;background:#ffffff;color:#111111;display:flex;gap:12px;font:14px Inter;z-index:10';
    const toggle = document.createElement('button'), slider = document.createElement('input'), label = document.createElement('output');
    toggle.textContent = 'Pause'; toggle.setAttribute('aria-label', 'Pause or play animation');
    slider.type = 'range'; slider.min = '0'; slider.max = String(scene.timeline.durationMs - stepMs); slider.step = String(stepMs); slider.value = '0'; slider.style.flex = '1'; slider.setAttribute('aria-label', 'Animation time');
    bar.append(toggle, slider, label); document.body.append(bar);
    let playing = true, origin = performance.now(), current = 0;
    function display(t) { current = t; __TECH_GIF__.seek(t); slider.value = String(t); label.textContent = t + ' ms'; }
    toggle.onclick = () => { playing = !playing; origin = performance.now() - current; toggle.textContent = playing ? 'Pause' : 'Play'; };
    slider.oninput = () => { playing = false; toggle.textContent = 'Play'; display(Number(slider.value)); };
    function tick(now) { if (playing) display(Math.floor(TechGif.timeline.mod(now - origin, scene.timeline.durationMs) / stepMs) * stepMs); requestAnimationFrame(tick); }
    display(0); requestAnimationFrame(tick);
  })().catch(error => { console.error(error); const pre = document.createElement('pre'); pre.textContent = error.message; document.body.append(pre); });
  </script>`;
  return buildPageHtml().replace('</body>', script + '\n</body>');
}
async function run(argv) {
  const { values, positionals } = parse(argv, { fixture: { type: 'string' }, out: { type: 'string', short: 'o' }, open: { type: 'boolean', default: false } });
  const { scene, svgString } = input(positionals, values.fixture);
  const html = buildPreviewHtml(scene, svgString, Number(values.step)), outPath = absolute(values.out || rootPath('work', scene.id, 'preview.html'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, html);
  console.log('Interactive preview: ' + outPath);
  if (values.open) {
    const browser = await chromium.launch({ headless: false, args: values['launch-arg'] || config.launchArgs });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: scene.canvas.height } });
      const closed = new Promise(resolve => page.once('close', resolve));
      await page.setContent(html, { waitUntil: 'load' });
      await closed;
    } finally { await browser.close(); }
  }
  return { outPath };
}
module.exports = { run, buildPreviewHtml };
