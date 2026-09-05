'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { parseArgs } = require('../src/agent/cli-args.js');
const { main } = require('../bin/diagif.js');
const { AgentError, EXIT_CODES } = require('../src/agent/errors.js');

test('CLI grammar joins topic words and stops options at --', () => {
  assert.deepEqual(parseArgs(['make', 'explain', 'RAG', '--brain', 'mock', '--max-model-calls', '28']), {
    command: 'make', topic: 'explain RAG', options: { brain: 'mock', maxModelCalls: 28 }
  });
  assert.equal(parseArgs(['mindmap', '--', '--advanced', 'AI']).topic, '--advanced AI');
  assert.equal(parseArgs(['scout', '--make', '--count', '2']).options.make, true);
  assert.equal(parseArgs(['make', 'topic', '--resume-slug', 'topic-2']).options.resumeSlug, 'topic-2');
});

for (const args of [
  ['make', ''], ['make', ' '.repeat(3)], ['make', 'x'.repeat(181)], ['make', 'topic', '--brain'],
  ['make', 'topic', '--brain', 'mock', '--brain', 'mock'], ['make', 'topic', '--out', ''],
  ['make', 'topic', '--dry-run', '--dry-run'], ['make', 'topic', '--unknown'], ['make', 'topic', '--count', '2'],
  ['scout', '--count', '0'], ['scout', '--count', '11'], ['scout', '--count', '1.5'], ['scout', '--count', '1e1'],
  ['make', 'topic', '--max-model-calls', '201'], ['make', 'topic', '--max-model-calls', '-1'],
  ['scout', '--max-total-model-calls', '2001'], ['scout', '--max-total-model-calls', '0'],
  ['make', 'topic', '--research', 'auto'], ['make', 'topic', '--resume', '--resume-slug', 'a-b'],
  ['make', 'topic', '--resume-slug', '../escape'], ['brand'], ['brand', '--clear', '--url', 'https://example.com'],
  ['brand', '--clear', '--out', 'elsewhere'], ['doctor', 'topic'], ['scout', '--model', 'invented'], ['unknown']
]) test('rejects invalid grammar: ' + JSON.stringify(args), () => assert.throws(() => parseArgs(args), { code: 'USAGE', exitCode: 2 }));

test('help/version/usage never load provider, research or renderer implementations', async () => {
  const messages = [], dependencies = { log: text => messages.push(text), error: text => messages.push(text) };
  assert.equal(await main(['--help'], dependencies), 0);
  assert.match(messages[0], /heuristic virality/);
  assert.equal(await main(['--version'], dependencies), 0);
  assert.equal(messages[1], require('../package.json').version);
  assert.equal(await main(['make', ''], dependencies), 2);
  assert.ok(!Object.keys(require.cache).some(file => /src[\\/]agent[\\/](brains|research|config)/.test(file)));
});

for (const [code, exit] of Object.entries(EXIT_CODES)) test('CLI maps ' + code + ' to exit ' + exit, async () => {
  const logs = [], harness = { runMake: async () => { throw new AgentError('intentional fixture failure', { code }); } };
  assert.equal(await main(['make', 'topic'], { harness, error: message => logs.push(message) }), exit);
  assert.match(logs[0], new RegExp('^' + code + ':'));
});

test('brand validation completes before save and uses only the config port', async () => {
  let saves = 0;
  const loaded = { configDir: 'C:/fixture', brand: { style: 'none' } };
  const config = { loadConfig: () => structuredClone(loaded), saveConfig: () => { saves++; },
    canonicalizeBrandUrl: () => { throw new AgentError('Invalid host', { code: 'USAGE' }); } };
  assert.equal(await main(['brand', '--url', 'https://bad.example/in/a'], { config, error: () => {} }), 2);
  assert.equal(saves, 0);
  assert.equal(await main(['brand', '--clear'], { config, log: () => {} }), 0);
  assert.equal(saves, 1);
});

test('CLI executable returns real process exit codes with shell:false', async () => {
  const cli = path.resolve(__dirname, '../bin/diagif.js');
  const invoke = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const help = await invoke(['--help']), version = await invoke(['--version']), empty = await invoke(['make', '']);
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /Usage: diagif/);
  assert.equal(version.code, 0, version.stderr); assert.equal(version.stdout.trim(), require('../package.json').version);
  assert.equal(empty.code, 2); assert.match(empty.stderr, /USAGE: Topic/);
});
