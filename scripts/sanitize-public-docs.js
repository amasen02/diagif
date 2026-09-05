#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveNativePathExecutable } = require('../src/agent/exec-resolve.js');

// Assemble signature literals so the scanner can inspect its own source.
const BUILTINS = [
  ['OPENAI', 'API_KEY'].join('_') + '=',
  'sk-' + '[A-Za-z0-9]{8,}',
  ['AI', 'za'].join(''),
  'BEGIN ' + '(RSA |EC )?PRIVATE KEY',
  String.raw`[A-Z]:\\Users\\`,
  String.raw`[C]:\\`,
  '/home/' + '[a-z]+/',
  String.raw`https?://[^\s]*(internal|corp|local)`
];
const LINK_FILES = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']);
const PUBLIC_LINK = 'github.com/' + ['ama', 'sen02'].join('') + '/diagif';

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd, env, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) throw new Error(`${command}: ${result.error.code || result.error.message}`);
  return result;
}

function isIgnored(relative, isDirectory, rules) {
  let ignored = false;
  for (const rule of rules) {
    let pattern = rule.value.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);
    const directoryOnly = pattern.endsWith('/');
    if (directoryOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith('/');
    pattern = pattern.replace(/^\//, '');
    const prefix = rule.base ? rule.base + '/' : '';
    const scoped = prefix + (anchored || pattern.includes('/') ? pattern : '**/' + pattern);
    let expression = '';
    for (let index = 0; index < scoped.length; index++) {
      const character = scoped[index];
      if (character === '*' && scoped[index + 1] === '*') {
        if (scoped[index + 2] === '/') { expression += '(?:.*/)?'; index += 2; }
        else { expression += '.*'; index++; }
      } else if (character === '*') expression += '[^/]*';
      else if (character === '?') expression += '[^/]';
      else expression += /[|\\{}()[\]^$+?.]/.test(character) ? '\\' + character : character;
    }
    const regex = new RegExp('^' + expression +
      (directoryOnly ? '(?:/|$)' : '$'));
    if (regex.test(relative)) ignored = !negated;
  }
  return ignored;
}

function ignoredTreeFiles(rootDir) {
  const files = [];
  function walk(directory, inheritedRules) {
    let rules = inheritedRules;
    const ignore = path.join(directory, '.gitignore');
    if (fs.existsSync(ignore)) {
      const base = path.relative(rootDir, directory).replaceAll('\\', '/');
      rules = rules.concat(fs.readFileSync(ignore, 'utf8').split(/\r?\n/).map(value => ({ base, value })));
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(rootDir, absolute).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) continue;
      if (isIgnored(relative, entry.isDirectory(), rules)) {
        // Git may re-include a child of an ignored directory. Descend only when
        // a later negated rule can mention this directory, avoiding node_modules.
        const canReinclude = entry.isDirectory() && rules.some(rule => {
          const value = rule.value.trim();
          const unignored = value.slice(1).replace(/^\//, '');
          return value.startsWith('!') && (unignored.includes(relative + '/') || !unignored.includes('/'));
        });
        if (!canReinclude) continue;
      }
      if (entry.isDirectory()) walk(absolute, rules);
      else if (entry.isFile()) files.push(relative);
    }
  }
  walk(rootDir, []);
  return files.sort();
}

function enumerateFiles(rootDir, env = process.env) {
  let top;
  try { top = run('git', ['rev-parse', '--show-toplevel'], rootDir, env); } catch { top = null; }
  // An ignored checkout inside another repository is not that repository's scan root.
  const ownRepo = top?.status === 0 &&
    fs.realpathSync(top.stdout.trim()) === fs.realpathSync(rootDir);
  let result;
  if (ownRepo) {
    try { result = run('git', ['ls-files', '-z', '--cached'], rootDir, env); } catch { result = null; }
  }
  if (result && result.status !== 0) {
    throw new Error(`File enumeration failed (${result.status}): ${result.stderr.trim()}`);
  }
  return { mode: result ? 'git ls-files' : 'working tree',
    files: result ? [...new Set(result.stdout.split('\0').filter(Boolean))].sort() : ignoredTreeFiles(rootDir) };
}

function isAllowed(file, line) {
  // The exception applies only to the four named top-level public metadata files.
  return LINK_FILES.has(file) && (line.includes(PUBLIC_LINK) ||
    line.includes('npmjs.com/package/diagif'));
}

function hasLineAllowMarker(file, line) {
  const marker = /\.(?:[cm]?js|py)$/i.test(file) ? /\/\/\s*sanitize-allow:\s*\S/ :
    /\.md$/i.test(file) ? /<!--\s*sanitize-allow:\s*[^>\s][^>]*-->/ : null;
  return Boolean(marker && marker.test(line));
}

function scan({ rootDir = process.cwd(), denylist, env = process.env } = {}) {
  rootDir = path.resolve(rootDir);
  if (denylist) {
    denylist = path.resolve(denylist);
    fs.accessSync(denylist, fs.constants.R_OK);
  }
  const { mode, files } = enumerateFiles(rootDir, env);
  const textFiles = files.filter(file => {
    const target = path.resolve(rootDir, file);
    const relative = path.relative(rootDir, target);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('File enumeration escaped the scan root');
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error(`Cannot scan symbolic link: ${file}`);
    if (!stat.isFile()) throw new Error(`Cannot scan non-file: ${file}`);
    return !fs.readFileSync(target).includes(0);
  });
  const hits = new Map();
  const rg = resolveNativePathExecutable('rg', { env, cwd: rootDir });
  function addHit(file, line, number, label) {
    if (isAllowed(file, line) || hasLineAllowMarker(file, line)) return;
    const key = `${file}:${number}`;
    if (!hits.has(key)) hits.set(key, { file, line: number, rules: [] });
    hits.get(key).rules.push(label);
  }
  function search(args, label, chunk) {
    const result = run(rg.command, ['--json', '--line-number', '--hidden', '--no-ignore',
      '--no-config', '--color', 'never', ...args, '--', ...chunk], rootDir);
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`Pattern scan failed (${result.status}): ${result.stderr.trim()}`);
    }
    for (const record of result.stdout.split('\n').filter(Boolean)) {
      const event = JSON.parse(record);
      if (event.type !== 'match') continue;
      const decode = value => value.text ?? Buffer.from(value.bytes, 'base64').toString('utf8');
      const file = decode(event.data.path).replaceAll('\\', '/').replace(/^\.\//, '');
      const line = decode(event.data.lines);
      addHit(file, line, event.data.line_number, label);
    }
  }
  function nodeSearch(patterns, label) {
    for (const file of textFiles) {
      const lines = fs.readFileSync(path.join(rootDir, file), 'utf8').split(/\r?\n/);
      // split() adds a synthetic record after a terminal line ending; ripgrep
      // reports physical lines only, including deliberately blank ones.
      if (lines.at(-1) === '') lines.pop();
      for (let index = 0; index < lines.length; index++) {
        if (patterns.some(pattern => label === 'denylist' ? lines[index].includes(pattern) : new RegExp(pattern).test(lines[index]))) {
          addHit(file, lines[index], index + 1, label);
        }
      }
    }
  }
  // Keep explicit argv batches well below Windows' command-line limit.
  let chunk = [], length = 0;
  function flush() {
    if (!chunk.length) return;
    if (rg) {
      search(BUILTINS.flatMap(pattern => ['-e', pattern]), 'built-in', chunk);
      if (denylist) search(['--fixed-strings', '-f', denylist], 'denylist', chunk);
    }
    chunk = []; length = 0;
  }
  for (const file of textFiles) {
    if (length + file.length > 12000 || chunk.length >= 64) flush();
    chunk.push(file); length += file.length + 3;
  }
  flush();
  if (!rg) {
    nodeSearch(BUILTINS, 'built-in');
    if (denylist) {
      const patterns = fs.readFileSync(denylist, 'utf8').split(/\r?\n/);
      // A trailing newline terminates the final pattern; an intentional blank
      // line remains an empty fixed-string pattern, as in ripgrep's -f mode.
      if (patterns.at(-1) === '') patterns.pop();
      nodeSearch(patterns, 'denylist');
    }
  }
  return { mode, files: files.length, textFiles: textFiles.length,
    hits: [...hits.values()].sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line) };
}

function main(argv = process.argv.slice(2)) {
  let denylist, check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check' && !check) check = true;
    else if (argv[i] === '--denylist' && !denylist && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      denylist = argv[++i];
    } else throw new Error('Usage: sanitize-public-docs.js --check [--denylist FILE]');
  }
  if (!check) throw new Error('Usage: sanitize-public-docs.js --check [--denylist FILE]');
  const report = scan({ denylist });
  for (const hit of report.hits) {
    // Never echo a matching line: it may contain a credential.
    console.error(`${hit.file}:${hit.line}: ${hit.rules.join(', ')}`);
  }
  console.log(`Sanitisation: ${report.hits.length} hit(s), ${report.textFiles} text files / ${report.files} files (${report.mode}).`);
  return report.hits.length ? 1 : 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { scan, isAllowed, hasLineAllowMarker, enumerateFiles, main };
