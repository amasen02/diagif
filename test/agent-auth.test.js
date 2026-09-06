'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseStatus, probeCliAuth, getAuthStatuses } = require('../src/agent/auth');
const { selectBrain } = require('../src/agent/brains');
const { main } = require('../bin/diagif');
const { parseArgs } = require('../src/agent/cli-args');
const { AgentProviderUnavailable, exitCodeFor } = require('../src/agent/errors');
const executable = { command: process.execPath, path: 'official-cli.js', prefixArgs: ['official-cli.js'], version: '2.1.238', vision: true };

test('status parsing distinguishes logged out, authenticated, unsupported and failed probes', () => {
  assert.deepEqual(parseStatus('codex', { status: 0, stderr: 'Logged in using ChatGPT' }), { status: 'authenticated', accountType: 'ChatGPT' });
  assert.deepEqual(parseStatus('codex', { status: 0, stderr: 'Logged in using an API key - secret-value' }), { status: 'authenticated', accountType: 'API key' });
  assert.equal(parseStatus('codex', { status: 1, stderr: 'Not logged in' }).status, 'not-logged-in');
  for (const result of [{ status: 0, stdout: '' }, { status: 1, stderr: 'Logged in using ChatGPT' }, { error: true }, { signal: 'SIGTERM', stderr: 'Not logged in' }]) {
    assert.equal(parseStatus('codex', result).status, 'unknown');
  }
  assert.equal(parseStatus('claude', { status: 1, stdout: '{"loggedIn":false}' }).status, 'not-logged-in');
  assert.equal(parseStatus('claude', { status: 0, stdout: 'unsupported' }).status, 'unknown');
  assert.deepEqual(parseStatus('claude', { status: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max', email: 'private@example.test', token: 'private-token' }) }),
    { status: 'authenticated', accountType: 'Claude subscription' });
});

test('auth probes only official status argv, without shell or model calls, and never caches auth', async () => {
  for (const provider of ['codex', 'claude']) {
    let calls = 0;
    const options = { executable, env: {}, statusProbe: (command, args, opts) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['official-cli.js', ...(provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'])]);
      assert.equal(opts.shell, false); assert.equal(opts.timeout, 15000); assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
      return provider === 'codex' ? { status: 0, stderr: 'Logged in using ChatGPT' } : { status: 0, stdout: '{"loggedIn":true}' };
    } };
    assert.equal((await probeCliAuth(provider, options)).status, 'authenticated');
    await probeCliAuth(provider, options); assert.equal(calls, 2);
  }
});

test('status output never exposes API keys or failed probe diagnostics and gives setup commands', async () => {
  const rows = await getAuthStatuses({ env: { OPENAI_API_KEY: 'private-key' }, platform: 'win32', resolveExecutable: async () => executable,
    statusProbe: () => { throw Error('private-token'); } });
  assert.equal(rows[0].status, 'configured');
  assert.equal(rows[1].fix, "$env:ANTHROPIC_API_KEY = '<your API key>'");
  assert.equal(rows[2].status, 'unknown'); assert.equal(rows[2].fix, 'diagif auth --login codex');
  assert.equal(rows[4].status, 'available'); assert.doesNotMatch(JSON.stringify(rows), /private-key|private-token/);
  const absent = await probeCliAuth('codex', { resolveExecutable: () => { throw new AgentProviderUnavailable('missing'); } });
  assert.equal(absent.status, 'unavailable'); assert.match(absent.fix, /npm i -g @openai\/codex.*diagif auth --login codex/);
});

for (const provider of ['codex-cli', 'claude-cli']) test(provider + ' selection rejects unauthenticated CLI with exit 3 before any model call', async () => {
  await assert.rejects(selectBrain(provider, {}, { env: {}, executable,
    statusProbe: () => provider === 'codex-cli' ? { status: 1, stderr: 'Not logged in' } : { status: 1, stdout: '{"loggedIn":false}' },
    runProcess: () => assert.fail('must not dispatch a model call') }), error => {
    assert.ok(error instanceof AgentProviderUnavailable); assert.equal(exitCodeFor(error), 3);
    assert.match(error.message, new RegExp('diagif auth --login ' + provider.replace('-cli', ''))); return true;
  });
});

test('unknown CLI auth fails closed; authenticated selection succeeds', async () => {
  await assert.rejects(selectBrain('codex-cli', {}, { env: {}, executable, statusProbe: () => ({ status: 0, stdout: 'new format' }) }), /unknown.*diagif auth --login codex/);
  const brain = await selectBrain('codex-cli', {}, { env: {}, executable, statusProbe: () => ({ status: 0, stderr: 'Logged in using ChatGPT' }) });
  assert.equal(brain.provider, 'codex-cli');
});

test('auth login inherits stdio, uses shell:false argv and propagates child exit code', async () => {
  for (const provider of ['codex', 'claude']) {
    const code = await main(['auth', '--login', provider], { resolveExecutable: async () => executable, spawn: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['official-cli.js', ...(provider === 'codex' ? ['login'] : ['auth', 'login', '--claudeai'])]);
      assert.equal(options.shell, false); assert.equal(options.stdio, 'inherit');
      const child = new EventEmitter(); process.nextTick(() => child.emit('close', 7)); return child;
    } });
    assert.equal(code, 7);
  }
});

test('login help and dry-run cannot launch a browser; invalid auth options are rejected', async () => {
  const output = [], dependencies = { log: text => output.push(text), resolveExecutable: async () => executable, spawn: () => assert.fail('browser launched') };
  assert.equal(await main(['auth', '--login', 'codex', '--help'], dependencies), 0);
  assert.equal(await main(['auth', '--login', 'codex', '--dry-run'], dependencies), 0);
  assert.deepEqual(JSON.parse(output[1]), { command: process.execPath, args: ['official-cli.js', 'login'], shell: false, stdio: 'inherit' });
  for (const args of [['--login', 'openai'], ['--json', '--login', 'codex'], ['--dry-run'], ['topic']]) assert.throws(() => parseArgs(['auth', ...args]), { code: 'USAGE' });
});

test('auth JSON and doctor share statuses, mock does not suppress missing live brain hint', async () => {
  const statuses = [{ provider: 'codex', status: 'not-logged-in', fix: 'diagif auth --login codex' }, { provider: 'mock', status: 'available', detail: 'offline, no credentials' }];
  const output = [], deps = { log: text => output.push(text), getAuthStatuses: async () => statuses };
  assert.equal(await main(['auth', '--json'], deps), 0); assert.deepEqual(JSON.parse(output.pop()), statuses);
  assert.equal(await main(['doctor'], deps), 0);
  assert.ok(output.some(line => line.includes('codex: not-logged-in')));
  assert.ok(output.some(line => line.includes('no authenticated brain:')));
});
