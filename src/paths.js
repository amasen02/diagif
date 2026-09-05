'use strict';
const path = require('node:path');
const fs = require('node:fs');
const fg = require('fast-glob');
const forward = value => value.replace(/\\/g, '/');
const ROOT = forward(path.resolve(__dirname, '..'));
const absolute = (...parts) => forward(path.resolve(...parts));
const rootPath = (...parts) => absolute(ROOT, ...parts);
function scenePaths(id) {
  if (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(id)) throw new Error('Invalid scene id: ' + id);
  return { workDir: rootPath('work', id), outputDir: rootPath('output'), outPath: rootPath('output', id + '.gif') };
}
function expandInputs(args) {
  const files = new Set();
  for (const arg of args) {
    const normalized = forward(arg);
    if (!fg.isDynamicPattern(normalized)) {
      const resolved = absolute(normalized);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error('Input file not found: ' + arg);
      files.add(resolved);
    } else for (const file of fg.sync(normalized, { absolute: true, onlyFiles: true })) files.add(forward(file));
  }
  if (!files.size) throw new Error('No input scenes matched');
  return [...files].sort();
}
module.exports = { ROOT, root: ROOT, forward, absolute, rootPath, scenePaths, expandInputs };
