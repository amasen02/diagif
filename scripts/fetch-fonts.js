'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'tech-gifs-vendor' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) { const error = new Error(response.status + ' ' + url); error.status = response.status; throw error; }
  return Buffer.from(await response.arrayBuffer());
}
async function githubJson(repo, resource) { return JSON.parse((await download('https://api.github.com/repos/' + repo + '/' + resource)).toString()); }
async function commit(repo, branch) { return (await githubJson(repo, 'commits/' + branch)).sha; }
function rawUrl(repo, sha, file) { return 'https://raw.githubusercontent.com/' + repo + '/' + sha + '/' + file.split('/').map(encodeURIComponent).join('/'); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function deviation(message) {
  const file = path.join(ROOT, 'DEVIATIONS.md');
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes(message)) fs.appendFileSync(file, new Date().toISOString().slice(0, 10) + ' — ' + message + '\n');
}
async function pin() {
  const repo = 'google/fonts', pinnedCommit = await commit(repo, 'main'), files = [], licenses = [];
  const specs = [
    ['Lilita One', 'display', 'ofl/lilitaone/LilitaOne-Regular.ttf', '400'],
    ['Bebas Neue', 'condensed', 'ofl/bebasneue/BebasNeue-Regular.ttf', '400'],
    ['Inter', 'body', 'ofl/inter/Inter[opsz,wght].ttf', '100 900'],
    ['Patrick Hand', 'annotation', 'ofl/patrickhand/PatrickHand-Regular.ttf', '400'],
    ['JetBrains Mono', 'code', 'ofl/jetbrainsmono/JetBrainsMono[wght].ttf', '100 800'],
    ['Space Mono', 'labelMono', 'ofl/spacemono/SpaceMono-Regular.ttf', '400'],
    ['Space Mono', 'labelMono', 'ofl/spacemono/SpaceMono-Bold.ttf', '700'],
    ['Permanent Marker', 'marker', 'apache/permanentmarker/PermanentMarker-Regular.ttf', '400']
  ];
  for (const [family, weightRole, requestedPath, weight] of specs) {
    let sourcePath = requestedPath, bytes;
    try { bytes = await download(rawUrl(repo, pinnedCommit, sourcePath)); }
    catch (error) {
      if (error.status !== 404) throw error;
      const slug = requestedPath.split('/')[1];
      for (const category of ['ofl', 'apache']) {
        try {
          const entries = await githubJson(repo, 'contents/' + category + '/' + slug + '?ref=' + pinnedCommit);
          const match = entries.find(e => e.name === path.basename(requestedPath)) || entries.find(e => e.name.endsWith('.ttf'));
          if (match) { sourcePath = match.path; bytes = await download(rawUrl(repo, pinnedCommit, sourcePath)); break; }
        } catch (e) { if (e.status !== 404) throw e; }
      }
      if (!bytes) throw error;
      deviation('Font path ' + requestedPath + ' returned 404; GitHub contents API resolved ' + sourcePath + ' at ' + pinnedCommit + '.');
    }
    const dir = path.posix.dirname(sourcePath), slug = dir.split('/').pop();
    let licenseEntry = licenses.find(l => l.family === family);
    if (!licenseEntry) {
      const entries = await githubJson(repo, 'contents/' + dir + '?ref=' + pinnedCommit);
      const match = entries.find(e => /^(OFL|LICENSE)\.txt$/i.test(e.name));
      if (!match) throw new Error('No license found for ' + family);
      const data = await download(rawUrl(repo, pinnedCommit, match.path));
      const file = slug + '/' + match.name;
      fs.mkdirSync(path.join(ROOT, 'fonts', slug), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'fonts', file), data);
      licenseEntry = { family, file, path: match.path, sha256: sha256(data) }; licenses.push(licenseEntry);
    }
    const file = slug + '/' + path.posix.basename(sourcePath);
    fs.writeFileSync(path.join(ROOT, 'fonts', file), bytes);
    files.push({ family, weightRole, weight, file, path: sourcePath, license: licenseEntry.file, sha256: sha256(bytes) });
  }
  writeJson(path.join(ROOT, 'fonts/manifest.json'), { repo, pinnedCommit, files, licenses });
}
function manifestEntries(manifest) { return [...manifest.files, ...(manifest.licenses || [])]; }
async function verifyManifest(base, manifest, repair = false) {
  for (const item of manifestEntries(manifest)) {
    const file = path.resolve(base, item.file);
    if (!file.startsWith(path.resolve(base) + path.sep)) throw new Error('Unsafe manifest path: ' + item.file);
    if (!fs.existsSync(file) && repair) {
      const bytes = await download(rawUrl(item.repo || manifest.repo, item.pinnedCommit || manifest.pinnedCommit, item.path));
      if (sha256(bytes) !== item.sha256) throw new Error('sha256 mismatch: ' + item.file);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    }
    if (!fs.existsSync(file)) throw new Error('Missing asset: ' + item.file);
    if (sha256(fs.readFileSync(file)) !== item.sha256) throw new Error('sha256 mismatch: ' + item.file);
  }
  return manifestEntries(manifest).length;
}
async function run(argv = process.argv.slice(2)) {
  if (argv.includes('--pin')) await pin();
  const file = path.join(ROOT, 'fonts/manifest.json');
  if (!fs.existsSync(file)) throw new Error('Font manifest missing; run node scripts/fetch-fonts.js --pin');
  const manifest = JSON.parse(fs.readFileSync(file));
  const count = await verifyManifest(path.join(ROOT, 'fonts'), manifest, true);
  console.log('Fonts OK: ' + count + ' hashed files; google/fonts@' + manifest.pinnedCommit);
}
if (require.main === module) run().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { ROOT, download, githubJson, commit, rawUrl, sha256, writeJson, verifyManifest, deviation, run };
