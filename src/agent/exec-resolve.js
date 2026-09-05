'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { writeFileAtomic } = require('../fs-atomic.js');
const { AgentProviderUnavailable } = require('./errors.js');

const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code' };
const run = (command, args, options) => spawnSync(command, args, {
  ...options, shell: false, windowsHide: true, encoding: 'utf8',
  timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
});
function fileStat(file) {
  try { const stat = fs.statSync(file); return stat.isFile() ? stat : null; }
  catch { return null; }
}
function candidate(file, platform, source) {
  const stat = fileStat(file);
  if (!stat) return null;
  const extension = path.extname(file).toLowerCase();
  if (['.cmd', '.bat', '.ps1'].includes(extension)) return null;
  if (extension === '.js') return { command: process.execPath, prefixArgs: [file], path: file, source };
  if (platform === 'win32' ? extension !== '.exe' : !(stat.mode & 0o111)) return null;
  return { command: file, prefixArgs: [], path: file, source };
}
function ancestors(directory) {
  const values = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    values.push(current);
    if (path.dirname(current) === current) break;
  }
  return values;
}
function pathDirectories(pathEnv, platform, cwd) {
  return [...new Set(pathEnv.split(platform === 'win32' ? ';' : ':').filter(Boolean)
    .map(dir => path.resolve(cwd, dir.replace(/^"|"$/g, ''))))];
}
function nativePathCandidate(file, platform, source) {
  const stat = fileStat(file);
  if (!stat) return null;
  const extension = path.extname(file).toLowerCase();
  if (platform === 'win32') {
    if (extension !== '.exe') return null;
  } else if (!(stat.mode & 0o111)) return null;
  return { command: file, prefixArgs: [], path: file, source };
}

// Resolve utilities which may only be executed directly. This deliberately does
// not accept command or batch wrappers: Node's shell:false spawn cannot run them
// safely on Windows.
function resolveNativePathExecutable(name, { env = process.env, cwd = process.cwd(), platform = process.platform,
  pathEnv = env.PATH ?? env.Path ?? '', pathext = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD' } = {}) {
  cwd = path.resolve(cwd);
  const overrideName = 'DIAGIF_' + name.toUpperCase();
  const resolve = value => path.resolve(cwd, value);
  if (env[overrideName] !== undefined) return env[overrideName]
    ? nativePathCandidate(resolve(env[overrideName]), platform, 'env')
    : null;
  const extensions = platform === 'win32'
    ? pathext.split(';').map(value => value.trim().toLowerCase()).filter(value => value === '.exe')
    : [''];
  for (const directory of pathDirectories(pathEnv, platform, cwd)) {
    for (const extension of extensions) {
      const entry = nativePathCandidate(path.join(directory, name + extension), platform, 'path');
      if (entry) return entry;
    }
  }
  return null;
}

// Parse only the quoted JS argument of an npm node invocation, never execute
// or interpret the shim's batch source. Nonstandard wrappers are not trusted.
function npmShimJs(file) {
  if (!fileStat(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  if (!/@ECHO off/i.test(text)) return null;
  const matches = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/(?:"%_prog%"|"?node(?:\.exe)?"?)\s/i.test(line)) continue;
    const match = line.match(/"(?:%dp0%|%~dp0)(\\\.\.\\[^"\r\n]+\.js|\\node_modules\\[^"\r\n]+\.js)"\s+%\*/i);
    if (match) matches.push(path.resolve(path.dirname(file), match[1].replace(/\\/g, path.sep).replace(/^[/\\]/, '')));
  }
  return matches.length === 1 ? matches[0] : null;
}

function npmRoot(dirs, { cwd, env, platform }) {
  const cliPaths = [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const dir of dirs) {
    cliPaths.push(path.join(dir, 'node_modules/npm/bin/npm-cli.js'));
    if (platform === 'win32') {
      const js = npmShimJs(path.join(dir, 'npm.cmd'));
      if (js) cliPaths.push(js);
    }
  }
  const js = cliPaths.find(file => fileStat(file));
  const executable = platform !== 'win32' && dirs.map(dir => candidate(path.join(dir, 'npm'), platform, 'npm')).find(Boolean);
  const probe = js ? run(process.execPath, [js, 'root', '-g'], { cwd, env }) :
    executable ? run(executable.command, ['root', '-g'], { cwd, env }) : null;
  return probe && !probe.error && probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : null;
}

function packageCandidates(name, roots, platform) {
  const pkg = packages[name];
  const packageDirs = new Set();
  try { packageDirs.add(path.dirname(require.resolve(pkg + '/package.json', { paths: roots }))); } catch {}
  for (const root of roots) {
    // Also handles package.json hidden by an exports map and npm root -g.
    for (const dir of [path.join(root, pkg), path.join(root, 'node_modules', pkg)]) {
      if (fileStat(path.join(dir, 'package.json'))) packageDirs.add(dir);
    }
  }
  const result = [];
  for (const dir of packageDirs) {
    const binaryPkg = path.join(path.dirname(dir), path.basename(pkg) + '-' + platform + '-' + process.arch);
    if (name === 'claude') result.push(path.join(binaryPkg, 'claude' + (platform === 'win32' ? '.exe' : '')));
    else {
      const vendor = path.join(binaryPkg, 'vendor');
      let triples = [];
      try { triples = fs.readdirSync(vendor, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(); } catch {}
      const archTokens = process.arch === 'x64' ? ['x86_64', 'x64'] : process.arch === 'arm64' ? ['aarch64', 'arm64'] : [process.arch];
      for (const triple of triples.filter(triple => archTokens.some(token => triple.includes(token)))) {
        result.push(path.join(vendor, triple, 'bin', 'codex' + (platform === 'win32' ? '.exe' : '')));
      }
    }
  }
  return result;
}

async function verify(entry, { cwd, env }) {
  const stat = fs.statSync(entry.path);
  const key = createHash('sha256').update(entry.path + stat.mtimeMs + stat.size).digest('hex');
  const cacheFile = path.join(cwd, '.cache', 'agent', 'probe-' + key + '.json');
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.path === entry.path && cached.version?.trim() && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { ...entry, version: cached.version };
    }
  } catch {}
  const probe = run(entry.command, [...entry.prefixArgs, '--version'], { cwd, env });
  if (probe.error || probe.status !== 0 || !probe.stdout.trim()) return null;
  const version = probe.stdout.trim();
  // A read-only cwd must not make an otherwise usable provider unavailable.
  await writeFileAtomic(cacheFile, JSON.stringify({ path: entry.path, mtimeMs: stat.mtimeMs, size: stat.size, version }) + '\n').catch(() => {});
  return { ...entry, version };
}

async function resolveExecutable(name, { env = process.env, cwd = process.cwd(), platform = process.platform,
  pathEnv = env.PATH ?? env.Path ?? '' } = {}) {
  if (!Object.hasOwn(packages, name)) throw new AgentProviderUnavailable('Unsupported executable: ' + name);
  cwd = path.resolve(cwd);
  const overrideName = 'DIAGIF_' + name.toUpperCase();
  const unavailable = () => new AgentProviderUnavailable(`Cannot resolve ${name}. Set ${overrideName}=<path to ${name}${platform === 'win32' ? '.exe' : ''}>`);
  if (env[overrideName] !== undefined) {
    if (!env[overrideName]) throw unavailable();
    const entry = candidate(path.resolve(cwd, env[overrideName]), platform, 'env');
    const resolved = entry && await verify(entry, { cwd, env });
    if (!resolved) throw unavailable();
    return resolved;
  }
  const dirs = pathDirectories(pathEnv, platform, cwd);
  const roots = [cwd];
  const globalRoot = npmRoot(dirs, { cwd, env, platform });
  if (globalRoot) roots.push(globalRoot);
  for (const dir of dirs) {
    if (['', '.exe', '.cmd', '.bat', '.ps1'].some(ext => fileStat(path.join(dir, name + ext)))) roots.push(...ancestors(dir));
  }
  const candidates = packageCandidates(name, [...new Set(roots)], platform).map(file => candidate(file, platform, 'package'));
  for (const dir of dirs) candidates.push(candidate(path.join(dir, name + (platform === 'win32' ? '.exe' : '')), platform, 'path'));
  if (platform === 'win32') for (const dir of dirs) {
    const js = npmShimJs(path.join(dir, name + '.cmd'));
    if (js) candidates.push(candidate(js, platform, 'npm-shim'));
  }
  const seen = new Set();
  for (const entry of candidates.filter(Boolean)) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const resolved = await verify(entry, { cwd, env });
    if (resolved) return resolved;
  }
  throw unavailable();
}

module.exports = { resolveExecutable, resolveNativePathExecutable };
