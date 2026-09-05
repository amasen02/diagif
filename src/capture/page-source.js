'use strict';
const fs = require('node:fs');
const { rootPath } = require('../paths.js');
const { sha256 } = require('../../scripts/fetch-fonts.js');
function buildPageHtml() {
  const manifest = JSON.parse(fs.readFileSync(rootPath('fonts/manifest.json')));
  const fonts = manifest.files.map(font => {
    const bytes = fs.readFileSync(rootPath('fonts', font.file));
    if (sha256(bytes) !== font.sha256) throw new Error('sha256 mismatch: ' + font.file);
    return '@font-face{font-family:' + JSON.stringify(font.family) + ';src:url(data:font/ttf;base64,' + bytes.toString('base64') + ') format("truetype");font-weight:' + font.weight + ';font-style:normal;font-display:block;}';
  }).join('\n');
  const loadOrder = require('../renderer/manifest.json');
  const runtime = loadOrder.flatMap(name => {
    const file = rootPath('src/renderer', name + '.js');
    // Phase 1 modules are owned by independent jobs; mounting names any absent dependency.
    if (!fs.existsSync(file)) return [];
    return ['<script>\n' + fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script') + '\n</script>'];
  }).join('\n');
  let html = fs.readFileSync(rootPath('src/renderer/page.html'), 'utf8');
  for (const token of ['<!--INJECT:FONTS-->', '<!--INJECT:RUNTIME-->']) if (html.split(token).length !== 2) throw new Error('Expected exactly one ' + token);
  html = html.replace('<!--INJECT:FONTS-->', () => '<style>\n' + fonts + '\n</style>').replace('<!--INJECT:RUNTIME-->', () => runtime);
  if (/\bsrc\s*=\s*["']?(?!data:)/i.test(html) || /url\(\s*["']?(?!data:)/i.test(html)) throw new Error('Render page contains an external resource reference');
  return html;
}
module.exports = { buildPageHtml };
