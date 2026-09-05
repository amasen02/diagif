'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { rootPath } = require('../paths.js');
const { runProcess } = require('../python.js');
const { resolveExecutable } = require('./gifski.js');
async function discover() {
  for (const candidate of (process.env.TECH_GIFS_GIFSICLE ? [process.env.TECH_GIFS_GIFSICLE] : [rootPath('tools/bin/gifsicle' + (process.platform === 'win32' ? '.exe' : '')), 'gifsicle'])) {
    try {
      const command = resolveExecutable(candidate);
      if (!command) continue;
      const result = await runProcess(command, ['--version'], { timeout: 15000 });
      if (result.code === 0) return { command, path: command, version: result.stdout.trim() };
    } catch { /* Optional executable: try next location. */ }
  }
  return null;
}
async function optimize({ gifPath, outPath, lossy = false, tool }) {
  tool ||= await discover();
  if (!tool) return null;
  const argv = ['-O3', ...(lossy ? ['--lossy=30'] : []), path.resolve(gifPath), '-o', path.resolve(outPath)];
  const result = await runProcess(tool.command, argv);
  fs.writeFileSync(outPath + '.log', JSON.stringify({ tool, argv }) + '\n' + result.stdout + result.stderr);
  if (result.code !== 0) throw new Error(`gifsicle exit ${result.code}: ${result.stderr}`);
  return { gifPath: path.resolve(outPath), candidate: lossy ? 'lossy' : 'o3', lossy, bytes: fs.statSync(outPath).size, argv, tool };
}
module.exports = { discover, optimize };
