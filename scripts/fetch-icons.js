'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, download, githubJson, commit, rawUrl, sha256, writeJson, verifyManifest, deviation } = require('./fetch-fonts.js');
const lineNames = 'laptop monitor server database cloud globe user users bot cpu folder file-text file-code mail message-square calendar lock key shield git-branch network route zap clock layers box package table list search settings plug cable arrow-right-left timer bell gauge hard-drive wifi check x bookmark-plus refresh-cw'.split(' ');
const brandNames = 'mongodb redis postgresql mysql rabbitmq slack gmail jira confluence asana googledocs googlecalendar openai anthropic googlegemini docker kubernetes apachekafka github python react nodedotjs typescript linkedin x'.split(' ');
const knownColors = { mongodb: '47A248', redis: 'FF4438', postgresql: '4169E1', mysql: '4479A1', rabbitmq: 'FF6600', slack: '4A154B', gmail: 'EA4335', jira: '0052CC', confluence: '172B4D', asana: 'F06A6A', googledocs: '4285F4', googlecalendar: '4285F4', linkedin: '0A66C2' };
async function pin() {
  const repos = { lucide: 'lucide-icons/lucide', brands: 'simple-icons/simple-icons' }, pinnedCommits = {};
  for (const [key, repo] of Object.entries(repos)) pinnedCommits[key] = await commit(repo, key === 'lucide' ? 'main' : 'develop');
  const files = [], licenses = [], colors = {};
  let brandData;
  try { brandData = JSON.parse((await download(rawUrl(repos.brands, pinnedCommits.brands, '_data/simple-icons.json'))).toString()); }
  catch (error) {
    if (error.status !== 404) throw error;
    brandData = null;
  }
  for (const [group, names] of [['lucide', lineNames], ['brands', brandNames]]) {
    for (const name of names) {
      const repo = repos[group], sourcePath = 'icons/' + name + '.svg';
      let pinnedCommit = pinnedCommits[group], bytes;
      try { bytes = await download(rawUrl(repo, pinnedCommit, sourcePath)); }
      catch (error) {
        if (error.status !== 404 || group !== 'brands') throw error;
        // Removed marks remain available in their last upstream revision, never invented locally.
        const history = await githubJson(repo, 'commits?path=' + encodeURIComponent(sourcePath) + '&per_page=1');
        if (!history.length) throw error;
        const removal = await githubJson(repo, 'commits/' + history[0].sha);
        pinnedCommit = removal.parents[0].sha;
        bytes = await download(rawUrl(repo, pinnedCommit, sourcePath));
        deviation('Simple Icons ' + name + ' is absent at current commit; vendored its last available upstream version at ' + pinnedCommit + '.');
      }
      const svg = bytes.toString('utf8');
      if (!/<svg\b/.test(svg) || !/viewBox="0 0 24 24"/.test(svg) || /<(?:script|foreignObject)\b|\bon\w+=|(?:href|src)\s*=|url\(/i.test(svg)) throw new Error('Unsafe or unsupported icon: ' + name);
      const file = group + '/' + name + '.svg';
      fs.mkdirSync(path.join(ROOT, 'assets/icons', group), { recursive: true }); fs.writeFileSync(path.join(ROOT, 'assets/icons', file), bytes);
      files.push({ name, source: group === 'lucide' ? 'line' : 'brand', file, repo, pinnedCommit, path: sourcePath, sha256: sha256(bytes) });
      if (group === 'brands') {
        const rows = brandData?.icons || brandData || [];
        const entry = Array.isArray(rows) && rows.find(i => (i.slug || i.title.toLowerCase().replace(/\./g, 'dot').replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '')) === name);
        let hex = knownColors[name] || entry?.hex;
        if (!hex) {
          // Current repository stores each icon's metadata beside its SVG.
          for (const metadataPath of ['data/simple-icons.json', '_data/simple-icons.json', 'data/icons/' + name + '.json']) {
            try {
              const data = JSON.parse((await download(rawUrl(repo, pinnedCommit, metadataPath))).toString());
              const candidates = data.icons || data;
              const found = Array.isArray(candidates) ? candidates.find(i => (i.slug || i.title.toLowerCase().replace(/\./g, 'dot').replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '')) === name) : data;
              if (found?.hex) { hex = found.hex; break; }
            } catch (e) { if (e.status !== 404) throw e; }
          }
        }
        if (!hex) throw new Error('Brand hex unavailable for ' + name);
        colors[name] = '#' + hex.replace(/^#/, '').toUpperCase();
      }
    }
    const repo = repos[group], pinnedCommit = pinnedCommits[group];
    const sourcePath = group === 'brands' ? 'LICENSE.md' : 'LICENSE', bytes = await download(rawUrl(repo, pinnedCommit, sourcePath)), file = group + '/LICENSE';
    fs.writeFileSync(path.join(ROOT, 'assets/icons', file), bytes);
    licenses.push({ file, repo, pinnedCommit, path: sourcePath, sha256: sha256(bytes) });
  }
  writeJson(path.join(ROOT, 'assets/icons/brands/colors.json'), colors);
  const colorsSha256 = sha256(fs.readFileSync(path.join(ROOT, 'assets/icons/brands/colors.json')));
  writeJson(path.join(ROOT, 'assets/icons/manifest.json'), { repos, pinnedCommits, files, licenses, colors, colorsSha256 });
}
function generate(manifest) {
  const api = { lucide: {}, brands: {}, colors: manifest.colors };
  for (const item of manifest.files) {
    const svg = fs.readFileSync(path.join(ROOT, 'assets/icons', item.file), 'utf8');
    api[item.source === 'line' ? 'lucide' : 'brands'][item.name] = svg.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').replace(/<title>[\s\S]*?<\/title>/g, '').trim();
  }
  const source = '(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;root.TechGif=Object.assign(root.TechGif||{},{iconData:api});})(typeof globalThis!=="undefined"?globalThis:this,function(){return ' + JSON.stringify(api) + ';});\n';
  fs.writeFileSync(path.join(ROOT, 'src/renderer/icon-data.js'), source);
}
async function run(argv = process.argv.slice(2)) {
  if (argv.includes('--pin')) await pin();
  const file = path.join(ROOT, 'assets/icons/manifest.json');
  if (!fs.existsSync(file)) throw new Error('Icon manifest missing; run node scripts/fetch-icons.js --pin');
  const manifest = JSON.parse(fs.readFileSync(file));
  const count = await verifyManifest(path.join(ROOT, 'assets/icons'), manifest, true);
  const colorsFile = path.join(ROOT, 'assets/icons/brands/colors.json');
  if (!fs.existsSync(colorsFile)) writeJson(colorsFile, manifest.colors);
  if (sha256(fs.readFileSync(colorsFile)) !== manifest.colorsSha256) throw new Error('sha256 mismatch: brands/colors.json');
  generate(manifest);
  console.log('Icons OK: ' + count + ' hashed files; ' + JSON.stringify(manifest.pinnedCommits));
}
if (require.main === module) run().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { run, lineNames, brandNames };
