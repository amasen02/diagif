'use strict';
const fs = require('node:fs');
const { rootPath } = require('../paths.js');
const { resolvePython, runProcess } = require('../python.js');
const { verifyManifest, sha256 } = require('../../scripts/fetch-fonts.js');
async function discoverBinary(name) {
  for (const cmd of [process.env['TECH_GIFS_' + name.toUpperCase()], rootPath('tools/bin', name + (process.platform === 'win32' ? '.exe' : '')), name].filter(Boolean)) {
    try { const r = await runProcess(cmd, ['--version'], { timeout: 10000 }); if (r.code === 0) return { command: cmd, version: (r.stdout || r.stderr).trim().split(/\r?\n/)[0] }; } catch {}
  }
  return null;
}
async function run() {
  let failed = false;
  async function check(name, fn) { try { console.log(name + ': OK ' + await fn()); } catch (e) { failed = true; console.error(name + ': FAIL ' + e.message); } }
  await check('Node', () => { if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 required, found ' + process.version); return process.version; });
  await check('Chromium', () => { const { chromium } = require('playwright'), file = chromium.executablePath(); if (!fs.existsSync(file)) throw new Error(file + ' missing; run npm run setup (one-time network)'); return file + ' (offline cache matches Playwright ' + require('playwright/package.json').version + ')'; });
  await check('Python', async () => { const p = await resolvePython(); return p.command + ' ' + p.version + ', Pillow ' + p.pillowVersion; });
  for (const name of ['gifski', 'gifsicle']) { const found = await discoverBinary(name); console.log(name + ': ' + (found ? 'OK ' + found.command + ' ' + found.version : 'absent (optional)')); }
  for (const [name, dir] of [['Fonts', 'fonts'], ['Icons', 'assets/icons']]) await check(name, async () => {
    const manifest = JSON.parse(fs.readFileSync(rootPath(dir, 'manifest.json')));
    const count = await verifyManifest(rootPath(dir), manifest);
    if (manifest.colorsSha256 && sha256(fs.readFileSync(rootPath(dir, 'brands/colors.json'))) !== manifest.colorsSha256) throw new Error('sha256 mismatch: brands/colors.json');
    return count + ' hashes, pinned ' + JSON.stringify(manifest.pinnedCommit || manifest.pinnedCommits);
  });
  if (failed) process.exitCode = 1;
  return { ok: !failed };
}
module.exports = { run, discoverBinary };
