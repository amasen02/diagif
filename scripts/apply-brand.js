#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, expandInputs } = require('../src/paths.js');
const { writeFileAtomic } = require('../src/fs-atomic.js');
const { canonicalizeBrandUrl, validateScene } = require('../src/schema.js');

function parseArgs(args) {
  const options = { targets: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--config', '--out'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      options[arg.slice(2)] = path.resolve(value);
    } else if (['--allow-tracked', '--force', '--dry-run'].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === '--') { options.targets.push(...args.slice(i + 1)); break; }
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else options.targets.push(arg);
  }
  if (!options.targets.length) throw new Error('Explicit scene targets are required');
  return options;
}
function resolvedDestination(file) {
  if (fs.existsSync(file)) return fs.realpathSync(file);
  const parent = path.dirname(file);
  return path.join(parent === file ? parent : resolvedDestination(parent), path.basename(file));
}
function isTrackedPath(file, root = ROOT) {
  const protectedRoots = ['scenes', 'test', 'docs/examples'].map(dir => path.resolve(root, dir));
  const candidates = [path.resolve(file), resolvedDestination(path.resolve(file))];
  return candidates.some(candidate => protectedRoots.some(base => {
    const relative = path.relative(base, candidate);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  }));
}
async function applyBrand(options) {
  const configPath = options.config || path.resolve('diagif.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.brand?.url) throw new Error('Config must provide brand.url; no brand was created');
  const brand = { style: 'url-footer', url: canonicalizeBrandUrl(config.brand.url) };
  const files = await expandInputs(options.targets), report = { changed: [], unchanged: [], invalid: [], skipped: [] };
  if (!files.length) throw new Error('No targets matched');
  const destinations = new Set(), pending = [];
  for (const file of files) {
    const destination = options.out ? path.join(options.out, path.basename(file)) : file;
    if (!options['allow-tracked'] && isTrackedPath(destination)) throw new Error('Refusing tracked path: ' + destination + '; use --out DIR or --allow-tracked');
    const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
    if (destinations.has(key)) throw new Error('Multiple targets have the same output basename: ' + destination);
    destinations.add(key);
    try {
      const original = fs.readFileSync(file, 'utf8'), scene = JSON.parse(original);
      if (scene.brand?.style && !['none', 'url-footer'].includes(scene.brand.style) && !options.force) { report.skipped.push(file); continue; }
      const unchanged = JSON.stringify(scene.brand) === JSON.stringify(brand) || (scene.brand?.style === brand.style && scene.brand.url === brand.url && Object.keys(scene.brand).length === 2);
      let output = original;
      if (!unchanged) {
        const branded = {};
        for (const [key, value] of Object.entries(scene)) {
          branded[key] = key === 'brand' ? brand : value;
          if (key === 'title' && !Object.hasOwn(scene, 'brand')) branded.brand = brand;
        }
        if (!Object.hasOwn(branded, 'brand')) branded.brand = brand;
        const indent = original.match(/\n([\t ]+)"/)?.[1] || (original.includes('\n') ? '  ' : undefined);
        const newline = original.includes('\r\n') ? '\r\n' : '\n';
        output = JSON.stringify(branded, null, indent).replace(/\n/g, newline) + (original.endsWith('\n') ? newline : '');
      }
      const checked = validateScene(JSON.parse(output));
      if (!checked.valid) throw new Error(checked.errors.map(e => e.path + ': ' + e.message).join('; '));
      report[unchanged ? 'unchanged' : 'changed'].push(destination);
      if (!unchanged || (options.out && path.resolve(file) !== path.resolve(destination))) pending.push({ destination, output });
    } catch (error) { report.invalid.push({ file, message: error.message }); }
  }
  if (!options['dry-run']) for (const { destination, output } of pending) await writeFileAtomic(destination, output);
  return report;
}
async function main(args = process.argv.slice(2)) {
  const report = await applyBrand(parseArgs(args));
  console.log(JSON.stringify(report, null, 2));
  return report.invalid.length ? 2 : 0;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 2; });
module.exports = { parseArgs, applyBrand, main, isTrackedPath, canonicalizeBrandUrl };
