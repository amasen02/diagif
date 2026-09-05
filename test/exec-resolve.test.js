'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveExecutable, resolveNativePathExecutable } = require('../src/agent/exec-resolve.js');
const { AgentProviderUnavailable } = require('../src/agent/errors.js');

async function sandbox(t) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-exec-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const env = { ...process.env, DIAGIF_CODEX: undefined, DIAGIF_CLAUDE: undefined, npm_config_prefix: cwd, NPM_CONFIG_PREFIX: cwd };
  delete env.DIAGIF_CODEX; delete env.DIAGIF_CLAUDE;
  return { cwd, env, pathEnv: '' };
}
async function script(file, body) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  return file;
}
async function binary(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.copyFile(process.execPath, file);
  await fs.chmod(file, 0o755);
  return file;
}

test('env JS override uses the real Node executable, argument array and cache invalidation', async t => {
  const options = await sandbox(t), file = path.join(options.cwd, 'path with spaces', 'brain.js');
  await script(file, "if (process.argv[2] !== '--version') process.exit(2); console.log('brain 1');");
  options.env.DIAGIF_CODEX = file;
  const result = await resolveExecutable('codex', options);
  assert.equal(result.command, process.execPath); assert.deepEqual(result.prefixArgs, [file]);
  assert.equal(result.path, file); assert.equal(result.source, 'env'); assert.equal(result.version, 'brain 1');
  const cacheDir = path.join(options.cwd, '.cache', 'agent');
  const cache = await fs.readdir(cacheDir);
  assert.equal(cache.length, 1); assert.match(cache[0], /^probe-[a-f0-9]{64}\.json$/);
  assert.deepEqual(await resolveExecutable('codex', options), result);
  await script(file, "console.log('brain version 2');");
  assert.equal((await resolveExecutable('codex', options)).version, 'brain version 2');
  assert.equal((await fs.readdir(cacheDir)).length, 2);
});

test('invalid overrides fail closed, including batch shims and failed or empty version probes', async t => {
  const options = await sandbox(t);
  for (const [name, body] of [['bad.cmd', '@ECHO off'], ['fail.js', "console.log('version'); process.exit(3)"], ['empty.js', '']]) {
    options.env.DIAGIF_CODEX = await script(path.join(options.cwd, name), body);
    await assert.rejects(resolveExecutable('codex', options), AgentProviderUnavailable);
  }
  for (const value of ['', 'missing.exe']) {
    options.env.DIAGIF_CODEX = value;
    await assert.rejects(resolveExecutable('codex', options), /Set DIAGIF_CODEX=/);
  }
  await assert.rejects(resolveExecutable('unsupported', options), AgentProviderUnavailable);
});

test('package resolution discovers the installed architecture triple before a PATH executable', async t => {
  const options = await sandbox(t), suffix = process.platform === 'win32' ? '.exe' : '';
  const pkg = path.join(options.cwd, 'node_modules', '@openai');
  await script(path.join(pkg, 'codex', 'package.json'), '{"name":"@openai/codex","version":"0.0.0"}');
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
  const file = await binary(path.join(pkg, 'codex-' + process.platform + '-' + process.arch, 'vendor', arch + '-test-libc', 'bin', 'codex' + suffix));
  options.pathEnv = path.join(options.cwd, 'bin');
  await binary(path.join(options.pathEnv, 'codex' + suffix));
  const result = await resolveExecutable('codex', options);
  assert.equal(result.path, file); assert.equal(result.source, 'package'); assert.equal(result.version, process.version);
  assert.deepEqual(result.prefixArgs, []);
});

test('Claude sibling package and PATH native binaries resolve without shell shims', async t => {
  const options = await sandbox(t), suffix = process.platform === 'win32' ? '.exe' : '';
  options.pathEnv = path.join(options.cwd, 'bin');
  const pathBinary = await binary(path.join(options.pathEnv, 'codex' + suffix));
  assert.equal((await resolveExecutable('codex', options)).path, pathBinary);
  const pkg = path.join(options.cwd, 'node_modules', '@anthropic-ai');
  await script(path.join(pkg, 'claude-code', 'package.json'), '{"name":"@anthropic-ai/claude-code","version":"0.0.0"}');
  const file = await binary(path.join(pkg, 'claude-code-' + process.platform + '-' + process.arch, 'claude' + suffix));
  assert.equal((await resolveExecutable('claude', options)).path, file);
});

test('Windows npm shim fallback parses JS paths but never executes batch source', async t => {
  const options = await sandbox(t); options.platform = 'win32'; options.pathEnv = path.join(options.cwd, 'bin');
  const file = await script(path.join(options.pathEnv, 'node_modules', 'test-brain', 'bin.js'), "console.log('shim brain 1')");
  await script(path.join(options.pathEnv, 'codex.cmd'), '@ECHO off\r\n"%_prog%" "%~dp0\\node_modules\\test-brain\\bin.js" %*\r\n');
  const result = await resolveExecutable('codex', options);
  assert.equal(result.command, process.execPath); assert.deepEqual(result.prefixArgs, [file]); assert.equal(result.source, 'npm-shim');
  await script(path.join(options.pathEnv, 'codex.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\..\\bin\\node_modules\\test-brain\\bin.js" %*\r\n');
  assert.deepEqual((await resolveExecutable('codex', options)).prefixArgs, [file]);
  await script(path.join(options.pathEnv, 'codex.cmd'), '@ECHO off\r\ncall arbitrary-wrapper %*\r\n');
  await script(path.join(options.pathEnv, 'codex'), '#!/bin/sh\necho ignored');
  await assert.rejects(resolveExecutable('codex', options), /Set DIAGIF_CODEX=/);
});

test('shell:false spawn of the batch fixture yields EINVAL on Windows', { skip: process.platform !== 'win32' }, async () => {
  const file = path.join(__dirname, 'fixtures', 'shim.cmd');
  await assert.rejects(new Promise((resolve, reject) => {
    const child = spawn(file, [], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.once('error', reject); child.once('exit', code => resolve(code));
  }), { code: 'EINVAL' });
});

test('POSIX rejects files without execute bits', { skip: process.platform === 'win32' }, async t => {
  const options = await sandbox(t);
  const file = await script(path.join(options.cwd, 'codex'), '#!/bin/sh\necho fake');
  await fs.chmod(file, 0o644); options.env.DIAGIF_CODEX = file;
  await assert.rejects(resolveExecutable('codex', options), AgentProviderUnavailable);
});

test('native PATH resolution accepts only executable files and Windows .exe entries', async t => {
  const options = await sandbox(t);
  const bin = path.join(options.cwd, 'bin');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const native = await binary(path.join(bin, 'rg' + suffix));
  assert.deepEqual(resolveNativePathExecutable('rg', { ...options, pathEnv: bin }), {
    command: native, prefixArgs: [], path: native, source: 'path'
  });
  const windows = path.join(options.cwd, 'win-bin');
  await script(path.join(windows, 'rg.cmd'), '@ECHO off');
  assert.equal(resolveNativePathExecutable('rg', { ...options, platform: 'win32', pathEnv: windows, pathext: '.CMD' }), null);
  const winNative = await binary(path.join(windows, 'rg.exe'));
  assert.equal(resolveNativePathExecutable('rg', { ...options, platform: 'win32', pathEnv: windows, pathext: '.CMD;.EXE' }).path, winNative);
});
