'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const manifest = read('output/manifest.json');
const entries = Array.isArray(manifest) ? manifest : manifest.scenes || manifest.results;
if (!Array.isArray(entries)) throw new Error('Manifest has no scene entries');
const domains = new Map(Object.entries(read('config/domains.json').scenes));
const html = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const md = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const seen = new Set();
const scenes = entries.map(entry => {
  const id = entry.id;
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(id) || seen.has(id)) throw new Error('Invalid or duplicate scene id: ' + id);
  seen.add(id);
  const scene = read('scenes/' + id + '.json');
  const gif = path.join(root, 'output', id + '.gif');
  const qualityFile = 'output/' + id + '.gif.quality.json';
  const quality = fs.existsSync(path.join(root, qualityFile)) ? read(qualityFile) : null;
  const exists = fs.existsSync(gif);
  const contact = fs.existsSync(path.join(root, 'output', id + '.gif.contact.png'));
  const failures = [...(quality?.failures || [])];
  if (entry.status !== 'ok') failures.push(entry.error || 'Manifest status: ' + entry.status);
  if (!exists) failures.push('GIF missing');
  if (!quality) failures.push('Quality report missing');
  if (!contact) failures.push('Contact sheet missing');
  const bytes = exists ? fs.statSync(gif).size : 0;
  return { id, title: typeof scene.title === 'string' ? scene.title : scene.title.text,
    domain: domains.get(id) || 'smoke scene', duration: quality?.totalMs ?? scene.timeline.durationMs,
    frames: quality?.frames ?? entry.frameCount ?? 'unknown', bytes, kb: (bytes / 1000).toFixed(1),
    encoder: entry.encoder || 'unknown', candidate: entry.candidate || 'unknown',
    seam: quality?.loopSeamOk === true ? 'OK' : quality?.loopSeamOk === false ? 'FAIL' : 'unknown',
    flicker: quality?.flickerPixelCount ?? 'unknown', exists, contact, failures,
    ok: failures.length === 0 };
}).sort((a, b) => a.id.localeCompare(b.id));
const ok = scenes.filter(s => s.ok).length;
const failed = scenes.length - ok;
const bytes = scenes.reduce((sum, s) => sum + s.bytes, 0);
const totals = `${ok} scenes OK / ${failed} failed · ${bytes.toLocaleString('en-US')} bytes total (${(bytes / 1000).toFixed(1)} KB)`;
const chip = (label, good) => `<span class="chip ${good ? 'good' : 'bad'}">${html(label)}</span>`;
const cards = scenes.map(s => `<article class="card" data-domain="${html(s.domain)}">
<div class="art">${s.exists ? `<img src="./${s.id}.gif" alt="${html(s.title)}" loading="lazy" width="800">` : '<p>GIF missing</p>'}</div>
<div class="details"><p class="domain">${html(s.domain)}</p><h2>${html(s.title)}</h2><p class="id">${s.id}</p>
<p>${chip(s.ok ? 'OK' : 'FAILED', s.ok)} ${chip('Seam: ' + s.seam, s.seam === 'OK')} ${chip('Flicker: ' + s.flicker + ' px', s.flicker === 0)}</p>
<dl><dt>Duration</dt><dd>${s.duration} ms</dd><dt>Frames</dt><dd>${s.frames}</dd><dt>Size</dt><dd>${s.kb} KB (${s.bytes} bytes)</dd><dt>Encoder / candidate</dt><dd>${html(s.encoder)} / ${html(s.candidate)}</dd></dl>
${s.contact ? `<a href="./${s.id}.gif.contact.png">Contact sheet PNG</a>` : '<p>Contact sheet missing</p>'}
${s.failures.length ? `<p class="error">${html(s.failures.join('; '))}</p>` : ''}</div></article>`).join('\n');
const options = [...new Set(scenes.map(s => s.domain))].sort().map(d => `<option value="${html(d)}">${html(d)}</option>`).join('');
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Tech GIFs · Local gallery</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#081d24;color:#e8f4f5}*{box-sizing:border-box}body{margin:0}header,main,footer{max-width:1440px;margin:auto;padding:28px}header{padding-top:48px}h1{font-size:clamp(2rem,5vw,3.8rem);margin:0 0 12px}header p{color:#acc7ce}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:24px}select{font:inherit;padding:10px;background:#17353f;color:#fff;border:1px solid #7bb5c4;border-radius:6px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:24px}.card{background:#112d36;border:1px solid #31505a;border-radius:12px;overflow:hidden;min-width:0}.card[hidden]{display:none}.art{background:#06171c}.art img{width:100%;height:auto;display:block}.details{padding:20px}h2{font-size:1.25rem;line-height:1.35;margin:8px 0}.domain{color:#83dfce;font-size:.85rem}.id{font-family:monospace;overflow-wrap:anywhere;color:#b4c9cd}.chip{display:inline-block;font-size:.78rem;border-radius:6px;padding:5px 8px;margin:2px 0}.good{background:#15483d;color:#adf1dc}.bad,.error{background:#522b28;color:#ffcabd}dl{display:grid;grid-template-columns:1fr 1.5fr;gap:8px;font-size:.9rem}dt{color:#acc7ce}dd{margin:0;overflow-wrap:anywhere}a{color:#91dcf0}a:focus-visible,select:focus-visible{outline:3px solid #ffc374;outline-offset:4px}footer{color:#acc7ce}#visible{color:#acc7ce}
</style></head><body><header><p>TECHNICAL DIAGRAMS · LOCAL COLLECTION</p><h1>Tech GIFs</h1><p>${html(totals)}</p><p>KB uses decimal bytes. All GIFs and contact sheets load from this folder.</p><div class="toolbar"><label for="domain">Topic domain</label><select id="domain"><option value="">All domains</option>${options}</select><span id="visible" role="status" aria-live="polite">${scenes.length} scenes shown</span></div></header>
<main>${cards}</main><footer><a href="./GALLERY.md">Markdown gallery</a> · <a href="./SUMMARY.md">Render summary</a></footer>
<script>const filter=document.getElementById('domain');filter.addEventListener('change',()=>{let count=0;document.querySelectorAll('.card').forEach(card=>{card.hidden=filter.value!==''&&card.dataset.domain!==filter.value;if(!card.hidden)count++;});document.getElementById('visible').textContent=count+' scenes shown';});</script>
</body></html>\n`;
const columns = '| ID / GIF | Title | Domain | Status | Duration (ms) | Frames | Bytes (KB) | Encoder / candidate | Seam | Flicker (px) | Contact sheet |';
const table = [columns, '| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- |', ...scenes.map(s => `| [${s.id}](./${s.id}.gif) | ${md(s.title)} | ${md(s.domain)} | ${s.ok ? 'OK' : 'FAILED'} | ${s.duration} | ${s.frames} | ${s.bytes} (${s.kb}) | ${md(s.encoder)} / ${md(s.candidate)} | ${s.seam} | ${s.flicker} | [PNG](./${s.id}.gif.contact.png) |`)].join('\n');
fs.writeFileSync(path.join(root, 'output/index.html'), page);
fs.writeFileSync(path.join(root, 'output/GALLERY.md'), '# Local GIF gallery\n\n' + totals + '\n\nKB = 1,000 bytes.\n\n' + table + '\n');
const qualityNotes = scenes.flatMap(scene => scene.failures.map(failure => '- ' + scene.id + ': ' + md(failure)));
const summary = '# Render summary\n\n' + totals + '\n\nGenerated from output/manifest.json, scene JSON, config/domains.json and per-scene quality reports. Sizes are measured from local GIFs; KB = 1,000 bytes.\n\n' + table + '\n\n## Quality failures\n\n' + (qualityNotes.join('\n') || 'No failures reported.') + '\n\n## Re-render everything\n\nRun from the repository root in PowerShell:\n\n```powershell\nnode src/cli.js validate scenes/*.json\nnode src/cli.js render scenes/*.json\nnode scripts/build-gallery.js\n```\n\nRender includes the encoder ladder and quality gate. A full render replaces the manifest with all scenes; a subset render replaces it with only that subset unless you choose a separate --manifest path. Gallery generation also refreshes this summary.\n';
fs.writeFileSync(path.join(root, 'output/SUMMARY.md'), summary);
console.log(`Wrote ${scenes.length} cards to output/index.html; ${ok} OK, ${failed} failed.`);
console.log('Wrote output/GALLERY.md and output/SUMMARY.md.');
