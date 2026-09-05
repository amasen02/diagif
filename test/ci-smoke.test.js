'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd || ROOT, env: options.env || process.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function packedInventory() {
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await fs.access(npmCli);
  const result = await run(process.execPath, [npmCli, 'pack', '--dry-run', '--json']);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout)[0].files.map(entry => entry.path).sort();
}

test('package metadata exposes the renamed diagif CLI', async () => {
  const pkg = require('../package.json');
  assert.equal(pkg.name, 'diagif');
  assert.deepEqual(pkg.bin, { diagif: 'bin/diagif.js' });
  const help = await run(process.execPath, ['bin/diagif.js', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage: diagif/);
});

test('pack contains runtime agent resources and excludes development artifacts', async () => {
  const files = await packedInventory();
  for (const required of [
    'bin/diagif.js',
    'src/agent/fixtures/scene.json',
    'src/agent/fixtures/scene.quality.json',
    'src/agent/fixtures/research-mock-pages.json',
    'src/agent/prompts/contract-excerpt.md',
    'src/agent/research/index.js'
  ]) assert.ok(files.includes(required), 'missing packaged runtime resource: ' + required);
  for (const file of files) assert.equal(
    /^(?:tools\/bin\/|docs\/examples\/|out\/|\.cache\/|research\/)/.test(file),
    false,
    'development artifact leaked into package: ' + file
  );
});

test('a package-shaped isolated copy can perform an offline mock dry run', async t => {
  const files = await packedInventory();
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'diagif-pack-smoke-'));
  const packageRoot = path.join(sandbox, 'package');
  const outRoot = path.join(sandbox, 'out');
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  for (const relative of files) {
    const source = path.join(ROOT, relative), destination = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  const env = { ...process.env, DIAGIF_OFFLINE: '1', NODE_PATH: path.join(ROOT, 'node_modules') };
  const dryRun = await run(process.execPath, ['bin/diagif.js', 'make', 'explain RAG', '--brain', 'mock', '--dry-run', '--out', outRoot], { cwd: packageRoot, env });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  for (const file of ['run.json', 'post.md', 'steps/01-research.json', 'steps/02-brief.json']) {
    await fs.access(path.join(outRoot, 'explain-rag', file));
  }
});
