'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { extractJson, selectBrain, createBrainRunner } = require('../src/agent/brains');
const { createMockBrain } = require('../src/agent/brains/mock');
const { createOpenAIBrain } = require('../src/agent/brains/openai');
const { createAnthropicBrain } = require('../src/agent/brains/anthropic');
const { createCodexBrain } = require('../src/agent/brains/codex-cli');
const { createClaudeBrain, supportedVersion } = require('../src/agent/brains/claude-cli');
const { runProcess, wireFor } = require('../src/agent/brains/common');
const { createRunStore, newRun } = require('../src/agent/run-store');
const { loadConfig } = require('../src/agent/config');
const { AgentTruncatedError, AgentQuotaError, AgentProviderError } = require('../src/agent/errors');
const briefSchema = require('../src/agent/schemas/brief.schema.json');
const sceneSchema = require('../src/agent/schemas/scene-proposal.schema.json');
const expected = require('./fixtures/brains/brief.json');
const fixture = name => structuredClone(require('./fixtures/brains/' + name + '.json'));
const request = (overrides = {}) => ({ step: 'brief', schema: briefSchema, system: 'Return JSON', messages: [{ role: 'user', content: 'explain RAG' }], maxOutputTokens: 3000, timeoutMs: 1000, ...overrides });
const respond = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-brains-')); t.after(() => fs.rm(dir, { force: true, recursive: true })); return dir; }
async function context(t, maxModelCalls = 28) {
  const root = await temp(t), config = loadConfig({ cwd: root }), store = createRunStore(root);
  const run = newRun({ topic: 'explain RAG', config, brain: createMockBrain(), maxModelCalls });
  return { store, run, config };
}
test('extractJson chooses last JSON fence or last balanced top-level object with escapes', () => {
  const escaped = { new: 'brace } and \\"' };
  assert.deepEqual(extractJson('before {"old":1}\n```json\n' + JSON.stringify(escaped) + '\n```'), escaped);
  assert.deepEqual(extractJson('debug {"old":1} final {"text":"a } brace", "nested":{"x":2}}'), { text: 'a } brace', nested: { x: 2 } });
  assert.deepEqual(extractJson('```json\n{"old":1}\n```\n```json\n{"last":2}\n```'), { last: 2 });
});
test('extractJson rejects arrays, scalars, truncation and invalid final fence', () => {
  for (const raw of ['[]', '[{"nested":1}]', '42', 'null', '{"open":', '```json\n{"old":1}\n```\n```json\n{"bad":\n```']) assert.throws(() => extractJson(raw), { code: 'SCHEMA' });
});
test('mock is deterministic, offline and keys on original schema id', async () => {
  const brain = await selectBrain('mock', {}, { env: new Proxy({ DIAGIF_OFFLINE: '1' }, { get: (obj, key) => { if (/KEY|TOKEN|SECRET/.test(String(key))) throw Error('Read a secret'); return obj[key]; } }) });
  const first = await brain.complete(request()), second = await brain.complete(request());
  assert.deepEqual(first, second); assert.equal(first.usage.costUsd, 0); assert.equal(first.capability.vision, false);
  await assert.rejects(brain.complete(request({ schema: { $id: 'unknown' } })), { code: 'USAGE' });
});
test('explicit provider failure never falls through and hosted models are mandatory', async () => {
  await assert.rejects(selectBrain('openai', { brain: { openai: { model: 'chosen-model' } } }, { env: {} }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.throws(() => createOpenAIBrain({}, { env: { OPENAI_API_KEY: 'fixture' } }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.throws(() => createAnthropicBrain({}, { env: { ANTHROPIC_API_KEY: 'fixture' } }), { code: 'PROVIDER_UNAVAILABLE' });
});
test('offline selection fails before network or executable resolution', async () => {
  await assert.rejects(selectBrain('codex-cli', {}, { env: { DIAGIF_OFFLINE: '1' }, resolveExecutable: () => assert.fail('spawn') }), { code: 'OFFLINE' });
});
test('OpenAI Responses payload and usage come from recorded structured output', async () => {
  let body;
  const brain = createOpenAIBrain({ model: 'configured-model', reasoningEffort: 'low', pricePer1MTokens: { input: 2, output: 8 } }, { env: { OPENAI_API_KEY: 'fixture-key' }, fetch: async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.headers.Authorization, 'Bearer fixture-key'); body = JSON.parse(options.body); return respond(fixture('openai-completed'));
  } });
  const result = await brain.complete(request({ images: [{ data: 'cG5n' }] }));
  assert.deepEqual(result.value, expected); assert.equal(body.store, false); assert.equal(body.model, 'configured-model');
  assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.text.format.strict, true);
  assert.equal(body.input.at(-1).content.at(-1).type, 'input_image'); assert.equal(result.usage.costSource, 'price-table');
  assert.equal(result.usage.costUsd, (120 * 2 + 80 * 8) / 1e6);
});
for (const [name, code] of [['openai-truncated', 'TRUNCATED'], ['openai-refusal', 'REFUSAL']]) test(name + ' is typed', async () => {
  const brain = createOpenAIBrain({ model: 'configured' }, { env: { OPENAI_API_KEY: 'fixture' }, fetch: async () => respond(fixture(name)) });
  await assert.rejects(brain.complete(request()), { code });
});
test('OpenAI scene uses a loose non-strict wire shape and carries full original schema in prompt', async () => {
  let body;
  const brain = createOpenAIBrain({ model: 'configured' }, { env: { OPENAI_API_KEY: 'fixture' }, fetch: async (url, options) => { body = JSON.parse(options.body); return respond(fixture('openai-completed')); } });
  await brain.complete(request({ step: 'scene', schema: sceneSchema }));
  assert.equal(body.text.format.strict, false); assert.equal(body.text.format.schema.properties.scene.additionalProperties, true);
  assert.match(body.input[0].content[0].text, /Original acceptance schema/);
});
test('Anthropic uses output_config with no forced tools and includes images', async () => {
  let body;
  const brain = createAnthropicBrain({ model: 'configured-model' }, { env: { ANTHROPIC_API_KEY: 'fixture' }, fetch: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(options.headers['anthropic-version'], '2023-06-01'); body = JSON.parse(options.body); return respond(fixture('anthropic-completed'));
  } });
  const result = await brain.complete(request({ images: [{ data: 'cG5n' }] }));
  assert.deepEqual(result.value, expected); assert.equal(result.usage.costUsd, null); assert.equal(body.tools, undefined); assert.equal(body.tool_choice, undefined);
  assert.equal(body.output_config.format.type, 'json_schema'); assert.equal(body.messages.at(-1).content.at(-1).source.media_type, 'image/png');
});
test('Anthropic truncation and forced-tool 400 fail cleanly; legacy mode uses auto', async () => {
  const options = { env: { ANTHROPIC_API_KEY: 'fixture' }, fetch: async () => respond(fixture('anthropic-truncated')) };
  await assert.rejects(createAnthropicBrain({ model: 'chosen' }, options).complete(request()), { code: 'TRUNCATED' });
  options.fetch = async () => respond({ error: 'forced tool use is unsupported' }, 400);
  await assert.rejects(createAnthropicBrain({ model: 'chosen' }, options).complete(request()), error => error.code === 'PROVIDER' && !error.retryable && error.message.includes('chosen'));
  options.fetch = async (url, init) => { const body = JSON.parse(init.body); assert.deepEqual(body.tool_choice, { type: 'auto' }); assert.equal(body.output_config, undefined); return respond({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'emit_json', input: expected }] }); };
  assert.deepEqual((await createAnthropicBrain({ model: 'legacy', legacyToolMode: true }, options).complete(request())).value, expected);
});
test('HTTP auth and quota responses are typed regardless of JSON error shape', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [429, 'PROVIDER_QUOTA'], [503, 'PROVIDER']]) {
    const brain = createOpenAIBrain({ model: 'chosen' }, { env: { OPENAI_API_KEY: 'fixture' }, fetch: async () => respond({ error: 'failed' }, status) });
    await assert.rejects(brain.complete(request()), error => error.code === code && error.retryable === (status === 503));
  }
});
test('complete scene with mechanical schema errors reaches deterministic repair without spending a retry', async t => {
  const ctx = await context(t), value = structuredClone(require('./fixtures/agent-real-proposals/a4.json'));
  value.scene.nodes[0].invented = 'delete this property';
  let calls = 0;
  const brain = { provider: 'mock', model: 'fixture', complete: async () => { calls++; return { value: structuredClone(value) }; } };
  const result = await createBrainRunner(brain, ctx).complete(request({ step: 'scene', schema: sceneSchema, deferSceneValidation: true }));
  assert.deepEqual(result.value, value); assert.equal(calls, 1);
  assert.equal(ctx.run.budget.modelCallsUsed, 1); assert.equal(ctx.run.modelCalls[0].schemaValid, false);
  assert.deepEqual(ctx.store.readJson('steps/scene-a1.response.json'), value);
  const trace = require('../src/agent/scene-repair').deterministicRepair(result.value.scene);
  assert.ok(trace.some(edit => edit.path === '/nodes/0/invented' && edit.rule === 'unknown-property'));
  assert.equal(require('../src/schema').validateScene(result.value.scene).valid, true);
});

test('deferred scene validation still rejects malformed claim supports at the envelope', async t => {
  const ctx = await context(t), value = structuredClone(require('./fixtures/agent-real-proposals/a4.json'));
  value.claims[0].supports = [];
  const brain = { provider: 'mock', model: 'fixture', complete: async () => ({ value }) };
  await assert.rejects(createBrainRunner(brain, ctx).complete(request({ step: 'scene', schema: sceneSchema, deferSceneValidation: true })), { code: 'SCHEMA' });
});

test('schema retry persists budget before request and retains invalid response', async t => {
  const ctx = await context(t); const mock = createMockBrain('schema-retry'); const seen = [];
  const brain = { ...mock, complete: async req => { assert.equal(ctx.store.loadRun().budget.modelCallsUsed, seen.length + 1); seen.push(req); return mock.complete(req); } };
  const result = await createBrainRunner(brain, ctx).complete(request());
  assert.deepEqual(result.value, expected); assert.equal(ctx.run.budget.modelCallsUsed, 2); assert.equal(ctx.run.modelCalls.length, 2);
  assert.equal(ctx.run.modelCalls[0].schemaValid, false); assert.equal(ctx.run.modelCalls[1].schemaValid, true);
  assert.match(seen[1].messages.at(-1).content, /return the complete corrected JSON object/);
  assert.deepEqual(ctx.store.readJson('steps/brief-a1.response.json'), {});
});
test('truncation doubles output once without adding schema correction', async t => {
  const ctx = await context(t), mock = createMockBrain(), seen = [];
  const brain = { ...mock, complete: async req => { seen.push(req); if (seen.length === 1) throw new AgentTruncatedError('truncated', { details: { stopReason: 'max_tokens' } }); return mock.complete(req); } };
  await createBrainRunner(brain, ctx).complete(request());
  assert.deepEqual(seen.map(req => req.maxOutputTokens), [3000, 6000]); assert.deepEqual(seen[0].messages, seen[1].messages);
  assert.equal(ctx.run.modelCalls[0].stopReason, 'max_tokens');
});
test('second truncation stops; schema retries stop at three attempts', async t => {
  for (const truncated of [true, false]) {
    const ctx = await context(t), mock = createMockBrain();
    const brain = { ...mock, complete: async () => { if (truncated) throw new AgentTruncatedError('truncated'); return { ...(await mock.complete(request())), value: {} }; } };
    await assert.rejects(createBrainRunner(brain, ctx).complete(request()), { code: truncated ? 'TRUNCATED' : 'SCHEMA' });
    assert.equal(ctx.run.modelCalls.length, truncated ? 2 : 3);
  }
});
test('quota is never retried, transient transport is retried, budget stops before dispatch', async t => {
  for (const kind of ['quota', 'transient', 'budget']) {
    const ctx = await context(t, kind === 'budget' ? 1 : 28), mock = createMockBrain('schema-retry'); let calls = 0;
    const brain = { ...mock, complete: async req => { calls++; if (kind === 'quota') throw new AgentQuotaError('quota'); if (kind === 'transient' && calls === 1) throw new AgentProviderError('transient', { retryable: true }); return mock.complete(req); } };
    const promise = createBrainRunner(brain, ctx).complete(request());
    if (kind === 'transient') { await promise; assert.equal(calls, 3); }
    else { await assert.rejects(promise, { code: kind === 'quota' ? 'PROVIDER_QUOTA' : 'BUDGET_EXHAUSTED' }); assert.equal(calls, 1); }
    assert.equal(ctx.store.loadRun().budget.modelCallsUsed, calls);
  }
});
test('mock budget uses runner accounting instead of throwing before a durable dispatch', async t => {
  const ctx = await context(t, 2);
  const runner = createBrainRunner(createMockBrain('budget'), ctx);
  await runner.complete(request());
  await runner.complete(request());
  await assert.rejects(runner.complete(request()), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(ctx.run.budget.modelCallsUsed, 2);
  assert.equal(ctx.run.modelCalls.length, 2);
  assert.ok(ctx.run.modelCalls.every(call => call.schemaValid));
});
test('schema-valid scene proposals cannot inject branding', async t => {
  const ctx = await context(t), mock = createMockBrain();
  const brain = { ...mock, complete: async req => { const result = await mock.complete(req); result.value.scene.brand = { style: 'none' }; return result; } };
  await assert.rejects(createBrainRunner(brain, ctx).complete(request({ step: 'scene', schema: sceneSchema })), { code: 'SCHEMA' });
  assert.equal(ctx.run.modelCalls.length, 3);
});
test('mock scene-exhaust leaves schema-valid overlapping proposals for scene repair loop', async () => {
  const result = await createMockBrain('scene-exhaust').complete(request({ step: 'scene', schema: sceneSchema }));
  assert.equal(result.value.scene.nodes[0].x, result.value.scene.nodes[1].x); assert.equal(result.value.scene.nodes[0].y, result.value.scene.nodes[1].y);
  assert.equal(result.value.claims.some(claim => claim.text === result.value.scene.title.text), false);
  assert.ok(result.value.scene.nodes.every(node => node.label !== result.value.scene.title.text));
});
test('mock formats agentic content only when the request or brief forces mindmap', async () => {
  const makeBrief = await createMockBrain().complete(request({ messages: [{ role: 'user', content: JSON.stringify({ topic: 'agentic AI', forcedFormat: null }) }] }));
  assert.notEqual(makeBrief.value.format, 'mindmap');
  const mapBrief = await createMockBrain().complete(request({ messages: [{ role: 'user', content: JSON.stringify({ topic: 'agentic AI', forcedFormat: 'mindmap' }) }] }));
  assert.equal(mapBrief.value.format, 'mindmap');
  const makeScene = await createMockBrain().complete(request({ step: 'scene', schema: sceneSchema, format: 'how-it-works', messages: [{ role: 'user', content: JSON.stringify({ topic: 'agentic AI', brief: makeBrief.value }) }] }));
  assert.equal(makeScene.value.scene.layout.kind, 'freeform');
  const mapScene = await createMockBrain().complete(request({ step: 'scene', schema: sceneSchema, format: 'mindmap', messages: [{ role: 'user', content: JSON.stringify({ topic: 'agentic AI', brief: mapBrief.value }) }] }));
  assert.equal(mapScene.value.scene.layout.kind, 'mindmap');
});
test('codex builds array argv, schema artifact, image flags, stdin and reads result file', async t => {
  const root = await temp(t); let actual;
  const response = fixture('codex-completed');
  const brain = await createCodexBrain({}, { env: {}, runDir: root, executable: { command: process.execPath, prefixArgs: ['entry.js'], version: '0.153.3', vision: true }, runProcess: async (command, args, options) => {
    actual = { command, args, options }; await fs.writeFile(args[args.indexOf('-o') + 1], response.result); return response;
  } });
  const result = await brain.complete(request({ images: ['image.png'] }));
  assert.deepEqual(result.value, expected); assert.equal(result.usage.inputTokens, 95); assert.equal(result.wire.structured, true);
  assert.equal(actual.command, process.execPath); assert.equal(actual.args[0], 'entry.js'); assert.ok(actual.args.includes('--output-schema')); assert.ok(actual.args.includes('--ephemeral')); assert.ok(actual.args.includes('read-only'));
  assert.equal(actual.args[actual.args.indexOf('-i') + 1], 'image.png'); assert.match(actual.options.input, /Return JSON/);
  assert.equal(JSON.parse(await fs.readFile(actual.args[actual.args.indexOf('--output-schema') + 1], 'utf8')).additionalProperties, false);
});
test('codex zero-exit quota and stale/missing output are failures', async t => {
  const root = await temp(t); await fs.mkdir(path.join(root, 'steps')); const stale = path.join(root, 'steps', 'brief-a1.codex.txt');
  for (const name of ['codex-quota', 'codex-completed']) {
    await fs.writeFile(stale, JSON.stringify(expected));
    const response = fixture(name);
    const brain = await createCodexBrain({}, { env: {}, runDir: root, executable: { command: process.execPath, prefixArgs: [], version: '0.153.3', vision: false }, runProcess: async () => response });
    await assert.rejects(brain.complete(request()), { code: name === 'codex-quota' ? 'PROVIDER_QUOTA' : 'PROVIDER' });
  }
});
test('codex scene omits output-schema and reports unstructured extraction', async t => {
  const root = await temp(t); let argv;
  const brain = await createCodexBrain({}, { env: {}, runDir: root, executable: { command: process.execPath, prefixArgs: [], version: '0.153.3', vision: false }, runProcess: async (command, args) => {
    argv = args; await fs.writeFile(args[args.indexOf('-o') + 1], '{"scene":{}}'); return { code: 0, stdout: '', stderr: '' };
  } });
  const result = await brain.complete(request({ step: 'scene', schema: sceneSchema }));
  assert.equal(argv.includes('--output-schema'), false); assert.equal(result.wire.structured, false);
});
test('codex does not confuse valid topical discussion of auth and quotas with provider failures', async t => {
  const root = await temp(t);
  const brain = await createCodexBrain({}, { env: {}, runDir: root, executable: { command: process.execPath, prefixArgs: [], version: '0.153.3', vision: false }, runProcess: async (command, args) => {
    await fs.writeFile(args[args.indexOf('-o') + 1], '{"topic":"authentication and quota controls"}');
    return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal((await brain.complete(request())).value.topic, 'authentication and quota controls');
});
test('Claude envelope requires is_error false and a completed turn, uses structured output', async () => {
  let actual;
  const brain = await createClaudeBrain({}, { env: {}, executable: { command: process.execPath, prefixArgs: [], version: '2.1.261' }, runProcess: async (command, args, options) => {
    actual = { args, options }; return { code: 0, stdout: JSON.stringify(fixture('claude-completed')), stderr: '' };
  } });
  const result = await brain.complete(request());
  assert.deepEqual(result.value, expected); assert.equal(result.usage.costSource, 'cli-estimate'); assert.equal(result.capability.vision, false);
  assert.equal(actual.args[actual.args.indexOf('--tools') + 1], ''); assert.ok(actual.args.includes('--strict-mcp-config')); assert.equal(actual.args.includes('--bare'), false);
});
test('Claude zero-exit errors, zero turns and unstructured fallback are checked', async () => {
  for (const response of [fixture('claude-quota'), { is_error: false, num_turns: 0, result: '{}' }, { is_error: false, num_turns: 1, result: JSON.stringify(expected) }]) {
    const brain = await createClaudeBrain({}, { env: {}, executable: { command: process.execPath, prefixArgs: [], version: '2.1.261' }, runProcess: async () => ({ code: 0, stdout: JSON.stringify(response), stderr: '' }) });
    if (response.num_turns === 1 && response.is_error === false) assert.equal((await brain.complete(request())).wire.structured, false);
    else await assert.rejects(brain.complete(request()), { code: response.is_error ? 'PROVIDER_QUOTA' : 'PROVIDER' });
  }
});
test('Claude platform minimum versions are enforced', () => {
  assert.equal(supportedVersion('2.1.205', 'linux'), true); assert.equal(supportedVersion('2.1.205', 'win32'), false); assert.equal(supportedVersion('2.1.211', 'win32'), true); assert.equal(supportedVersion('nonsense', 'linux'), false);
});
test('real subprocess uses stdin, captures stderr, times out and rejects shims', async t => {
  const root = await temp(t), stderrPath = path.join(root, 'stderr.txt');
  const result = await runProcess(process.execPath, ['-e', "process.stdin.on('data',x=>process.stdout.write(x));process.stderr.write('fixture stderr')"], { input: 'prompt with spaces', timeoutMs: 5000, stderrPath });
  assert.equal(result.code, 0); assert.equal(result.stdout, 'prompt with spaces'); assert.equal(await fs.readFile(stderrPath, 'utf8'), 'fixture stderr');
  await assert.rejects(runProcess('test.cmd', [], {}), { code: 'PROVIDER_UNAVAILABLE' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), error => error.code === 'PROVIDER' && /timed out/.test(error.message));
});
