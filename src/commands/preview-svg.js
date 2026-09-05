'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { expandInputs, scenePaths, rootPath } = require('../paths.js');
const { normalizeScene } = require('../normalize-scene.js');
const { escape } = require('../renderer/svg-builder.js');
function fontCss() {
  const manifest = JSON.parse(fs.readFileSync(rootPath('fonts/manifest.json'), 'utf8'));
  return manifest.files.map(face => '@font-face{font-family:' + JSON.stringify(face.family) + ';font-weight:' + face.weight + ';src:url(data:font/ttf;base64,' + fs.readFileSync(rootPath('fonts', face.file)).toString('base64') + ') format("truetype");font-display:block;}').join('\n');
}
async function run(argv) {
  const results = [], failures = [];
  const inputs = expandInputs(argv), css = fontCss(), browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><head><style>' + css + '</style></head><body><svg xmlns="http://www.w3.org/2000/svg" id="text-measure"><text></text></svg></body></html>');
    // Preview only needs the static renderer, so another job's incomplete runtime
    // cannot prevent this command from producing its artifacts.
    const order = require('../renderer/manifest.json');
    for (const name of order.slice(0, order.indexOf('render-static') + 1).concat('page-runtime')) await page.addScriptTag({ content: fs.readFileSync(rootPath('src/renderer', name + '.js'), 'utf8') });
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map(face => face.load())); await document.fonts.ready;
      if ([...document.fonts].some(face => face.status !== 'loaded')) throw new Error('Preview font loading failed');
    });
    const markerMode = await page.evaluate(async () => {
      const { el, serialize, ref } = TechGif.svgBuilder;
      const probe = serialize(el('svg', { xmlns: 'http://www.w3.org/2000/svg', width: 30, height: 20 }, [el('defs', {}, TechGif.edges.markers()), el('path', { d: 'M 2,10 L 20,10', stroke: '#ff0000', 'stroke-width': 2, 'marker-end': ref('arrow') })]));
      const image = new Image(); image.src = 'data:image/svg+xml;base64,' + btoa(probe); await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 30; canvas.height = 20;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixel = context.getImageData(14, 7, 1, 1).data;
      return pixel[0] > 200 && pixel[1] < 30 && pixel[3] > 200 ? 'context-stroke' : 'per-color';
    });
  for (const file of inputs) {
    try {
      const scene = normalizeScene(JSON.parse(fs.readFileSync(file, 'utf8')));
      const output = await page.evaluate(({ scene, markerMode }) => TechGif.renderStatic.render(scene, { measureText: __TECH_GIF__.measureText, markerMode }), { scene, markerMode });
      // Bundling the same faces in both artifacts keeps measured text placement
      // identical when either the SVG or HTML is opened directly from disk.
      const standaloneSvg = output.svgString.replace(/(<svg\b[^>]*>)/, '$1<style>' + escape(css) + '</style>');
      const directory = scenePaths(scene.id).outputDir;
      fs.mkdirSync(directory, { recursive: true });
      const svgPath = path.join(directory, scene.id + '.preview.svg'), htmlPath = path.join(directory, scene.id + '.preview.html');
      fs.writeFileSync(svgPath, standaloneSvg + '\n', 'utf8');
      const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(scene.title.text) + '</title><style>' + css + '\nhtml,body{margin:0;background:#18262d}body{display:grid;place-items:start center}svg{display:block;max-width:100%;height:auto}</style></head><body>' + output.svgString + '</body></html>\n';
      fs.writeFileSync(htmlPath, html, 'utf8');
      console.log(scene.id + ': wrote ' + svgPath + ' + ' + htmlPath + ' (markers: ' + markerMode + ')');
      for (const warning of output.warnings) console.log('  warning: ' + warning);
      results.push({ sceneId: scene.id, svgPath, htmlPath });
    } catch (error) { failures.push({ file, error: error.message }); console.error(file + ': ' + error.message); }
  }
  } finally { await browser.close(); }
  if (failures.length) process.exitCode = 1;
  return { ok: !failures.length, results, failures };
}
module.exports = { run };
