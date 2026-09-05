'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateValue } = require('../src/agent/brains/schema');
const { loadConfig, saveConfig, canonicalizeBrandUrl, configProjection } = require('../src/agent/config');
const { createRunStore, newRun, slugify, uniqueSlug, hash, resolveResume } = require('../src/agent/run-store');
const { toWireSchema } = require('../src/agent/schemas/wire');
const { createMockBrain } = require('../src/agent/brains/mock');
const schemas = Object.fromEntries(['fact-sheet', 'brief', 'scene-proposal', 'critic-verdict', 'scout-result', 'run', 'config'].map(name => [name, require('../src/agent/schemas/' + name + '.schema.json')]));
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-contracts-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

for (const [name, step] of [['fact-sheet', 'research'], ['brief', 'brief'], ['scene-proposal', 'scene'], ['critic-verdict', 'critic'], ['scout-result', 'scout']]) {
  test('mock ' + name + ' validates against the original and rejects extra keys', async () => {
    const response = await createMockBrain().complete({ step, schema: schemas[name], messages: [] });
    assert.equal(validateValue(schemas[name], response.value), response.value);
    assert.throws(() => validateValue(schemas[name], { ...response.value, extra: true }), { code: 'SCHEMA' });
  });
}
for (const name of ['fact-sheet', 'brief', 'critic-verdict', 'scout-result']) {
  test(name + ' projects into a strict wire schema', () => {
    const wire = toWireSchema(schemas[name], 'openai-strict');
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      for (const key of Object.keys(value)) assert.ok(!['$ref', '$defs', '$id', '$schema', 'default', 'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems'].includes(key), key);
      if (value.properties) { assert.deepEqual(value.required, Object.keys(value.properties)); assert.equal(value.additionalProperties, false); }
      for (const [key, child] of Object.entries(value)) {
        if (key === 'properties') Object.values(child).forEach(visit);
        else visit(child);
      }
    }
    visit(wire);
  });
}
test('original constraints reject a wire-valid short hook and bad date while accepting UTC Z timestamps', async () => {
  const brief = structuredClone(require('./fixtures/brains/brief.json'));
  brief.hook = 'x'; assert.throws(() => validateValue(schemas.brief, brief), { code: 'SCHEMA' });
  const sheet = (await createMockBrain().complete({ schema: schemas['fact-sheet'] })).value;
  assert.equal(validateValue(schemas['fact-sheet'], sheet), sheet);
  sheet.retrievedAt = '2026-02-30T12:00:00Z'; assert.throws(() => validateValue(schemas['fact-sheet'], sheet), { code: 'SCHEMA' });
});
test('config discovery merges defaults, preserves provider absence and anchors output', async t => {
  const dir = await temp(t), child = path.join(dir, 'nested'); await fs.mkdir(child);
  await fs.writeFile(path.join(dir, 'diagif.config.json'), JSON.stringify({ version: 1, limits: { maxModelCalls: 4 } }));
  const cfg = loadConfig({ cwd: child });
  assert.equal(cfg.configDir, dir); assert.equal(cfg.limits.maxModelCalls, 4); assert.equal(cfg.limits.maxOutputTokens.scene, 16000);
  assert.equal(cfg.brain.provider, undefined); assert.equal(JSON.stringify(cfg).includes('configDir'), false);
});
test('config rejects secrets and invalid brand without changing existing bytes', async t => {
  const file = path.join(await temp(t), 'config.json');
  await saveConfig(file, { version: 1 }); const before = await fs.readFile(file);
  await assert.rejects(saveConfig(file, { version: 1, brain: { openai: { apiKey: 'private' } } }), { code: 'USAGE' });
  await assert.rejects(saveConfig(file, { version: 1, brand: { style: 'url-footer', url: 'https://evil.example/in/person' } }), { code: 'USAGE' });
  assert.deepEqual(await fs.readFile(file), before);
});
test('config URL canonicalisation and validation', () => {
  assert.equal(canonicalizeBrandUrl('https://linkedin.com/in/example/'), 'https://www.linkedin.com/in/example');
  for (const url of ['http://linkedin.com/in/example', 'https://linkedin.com/in/example?q=x', 'https://u:p@linkedin.com/in/example', 'https://linkedin.com/in/example#x', 'https://linkedin.com/in/x', 'https://linkedin.com:123/in/example']) assert.throws(() => canonicalizeBrandUrl(url), { code: 'USAGE' });
});
test('explicit missing config fails instead of silently using defaults', () => assert.throws(() => loadConfig('missing-agent-contracts-config.json'), { code: 'USAGE' }));
test('run writes are validated, redacted and atomic; content hashes ignore key order', async t => {
  const dir = await temp(t), store = createRunStore(dir, { env: { SERVICE_SECRET: 'private-data' } });
  const run = newRun({ topic: 'private-data', slug: 'redaction-check', config: loadConfig({ cwd: dir }) });
  await store.persist(run);
  assert.equal(store.loadRun().topic, '[REDACTED]'); assert.equal(run.topic, 'private-data');
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
  const previous = await fs.readFile(path.join(dir, 'run.json'));
  run.artifacts.gif = '../escape.gif'; assert.throws(() => store.persist(run));
  assert.deepEqual(await fs.readFile(path.join(dir, 'run.json')), previous);
  assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
});
test('step reuse verifies artifact hashes and rejects rejected candidates', async t => {
  const store = createRunStore(await temp(t)); const run = newRun({ topic: 'explain RAG' });
  const step = await store.persistStep('01-research', { facts: [1] }, { inputHash: 'same' }); run.steps.push(step);
  assert.equal(store.reusableStep(run, '01-research', 'same').status, 'reused');
  assert.equal(store.reusableStep(run, '01-research', 'other'), null);
  step.accepted = false; assert.equal(store.reusableStep(run, '01-research', 'same'), null); delete step.accepted;
  await store.writeJson(step.outputPath, { facts: [2] }); assert.equal(store.reusableStep(run, '01-research', 'same'), null);
});
test('slugs are portable, collisions suffix and ambiguous resume fails', async t => {
  const dir = await temp(t);
  assert.equal(slugify('Explain RAG!'), 'explain-rag'); assert.equal(slugify('CON'), 'con-topic'); assert.match(slugify('世界'), /^topic-/);
  for (const slug of ['explain-rag', 'explain-rag-2']) { const store = createRunStore(path.join(dir, slug)); await store.persist(newRun({ topic: 'explain RAG', slug })); }
  assert.equal(uniqueSlug('explain-rag', dir), 'explain-rag-3');
  assert.equal(uniqueSlug('explain-rag', dir), 'explain-rag-4');
  assert.throws(() => resolveResume(dir, 'explain RAG'), { code: 'RESUME_MISMATCH' });
  assert.equal(resolveResume(dir, 'explain RAG', 'explain-rag'), 'explain-rag');
  assert.throws(() => resolveResume(dir, 'different topic', 'explain-rag'), { code: 'RESUME_MISMATCH' });
});
test('run config projects only non-secret provider metadata', () => {
  const config = loadConfig(); const result = configProjection(config, { provider: 'mock', model: 'mock' });
  assert.equal(result.researchMode, 'mock'); assert.equal(result.brandStyle, 'none'); assert.equal(result.brain, undefined);
});
test('packaged runtime fixtures match the authored acceptance fixtures and example', async () => {
  for (const [runtime, original] of [['scene.json', 'test/fixtures/agent-mock-scene.json'], ['mindmap.json', 'test/fixtures/agent-mock-mindmap.json'],
    ['brief.json', 'test/fixtures/brains/brief.json'], ['mock-fact-sheets.json', 'test/fixtures/brains/mock-fact-sheets.json'], ['config-defaults.json', 'diagif.config.example.json']]) {
    assert.deepEqual(await fs.readFile(path.join(__dirname, '../src/agent/fixtures', runtime)), await fs.readFile(path.join(__dirname, '..', original)));
  }
});
test('packaged Pillow quality fixture retains actual renderer gate evidence', () => {
  const quality = require('../src/agent/fixtures/scene.quality.json');
  assert.deepEqual(quality.failures, []); assert.equal(quality.loopSeamOk, true); assert.equal(quality.totalMs, 4000);
  assert.equal(quality.width, 800); assert.equal(quality.height, 1000); assert.equal(quality.frames, 100); assert.ok(quality.bytes < 600000);
});
test('mindmap proposal remains authored and every tree label has a claim', async () => {
  const request = { step: 'scene', format: 'mindmap', topic: 'agentic AI', schema: schemas['scene-proposal'] };
  const { value } = await createMockBrain().complete(request);
  validateValue(schemas['scene-proposal'], value);
  assert.deepEqual(value.scene.nodes, []); assert.deepEqual(value.scene.edges, []); assert.deepEqual(value.scene.timeline.animations, []);
  assert.equal(value.scene.layout.mindmap.placement, undefined);
  for (const claim of value.claims) {
    const text = claim.path.slice(1).split('/').reduce((item, part) => item[part], value.scene); assert.equal(claim.text, text);
  }
  assert.equal(value.claims.length, 10);
});
