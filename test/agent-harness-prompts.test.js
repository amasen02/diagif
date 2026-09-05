'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createHarness } = require('../src/agent/harness.js');
const { collectDiagramText } = require('../src/agent/claims.js');
const { buildPrompt } = require('../src/agent/prompts.js');

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const source = { id: 'src-prompt', url: 'https://example.test/rag', title: 'RAG', provider: 'hn', publishedAt: '2026-01-01T00:00:00.000Z', engagement: { score: 1, comments: 1 } };
const sheet = { topic: 'RAG', retrievedAt: '2026-01-01T00:00:00.000Z', sources: [source], facts: [{ id: 'fact-1', sourceId: source.id, statement: 'Retrieve', quote: 'Retrieve relevant documents before generating an answer.' }] };
const brief = { topic: 'RAG', angle: 'how it works', hook: 'Retrieve before generating', format: 'how-it-works', factIds: ['fact-1'],
  post: { hook: 'Retrieve before generating', lines: ['Retrieve.', 'Generate.'], cta: 'Save.', hashtags: ['#RAG'] } };
function sceneProposal(id) {
  const scene = { id, canvas: { width: 800, height: 1000 }, title: { text: 'Retrieve before generating' }, layout: { kind: 'freeform' },
    nodes: Array.from({ length: 5 }, (_, i) => ({ id: 'node-' + i, label: 'Step ' + i, x: 32, y: 180 + i * 128, w: 160, h: 80 })),
    edges: [{ id: 'connect', from: 'node-0', to: 'node-1', label: { text: 'chunk + embed' } }], annotations: [],
    timeline: { durationMs: 4000, fps: 25, animations: [{ kind: 'pulse', nodeIds: ['node-0'], cyclesPerLoop: 2 }] } };
  return { scene, claims: collectDiagramText(scene).filter(slot => slot.path !== '/edges/0/label/text').map(slot => ({ ...slot, supports: ['fact-1'] })), authoringNotes: [] };
}

test('repair attempts receive the prior complete proposal and only remaining post-repair context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagif-retry-context-'));
  const prompts = [], initial = sceneProposal('first'), corrected = sceneProposal('second');
  const write = async (file, value) => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(value)); return { outputPath: file, outputHash: hash(value) }; };
  const store = { root, persist: async run => { await write('run.json', run); }, writeJson: write, writeText: async (file, text) => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); },
    persistStep: async (name, value, metadata) => ({ name, status: 'success', ...metadata, ...await write('steps/' + name + '.json', value) }), reusableStep: async () => null };
  const cfg = { configDir: root, brain: {}, research: { providers: ['hn'] }, limits: { maxModelCalls: 10, maxOutputTokens: { research: 1000, brief: 1000, scene: 1000, critic: 1000 },
    modelTimeoutMs: { research: 1000, brief: 1000, scene: 1000, critic: 1000 }, runTimeoutMs: 60000, researchDeadlineMs: 1000, inspectTimeoutMs: 1000, renderTimeoutMs: 1000 } };
  let sceneCalls = 0;
  const d = {
    hash: (...values) => hash(values), hashFile: async () => 'image', loadConfig: () => clone(cfg), selectBrain: () => ({ name: 'test', provider: 'test', model: 'test', capability: { vision: false } }),
    selectResearch: () => ({ collect: async () => ({ sources: [source], extracts: [], diagnostics: [] }) }), assertGrounded: value => value, slugify: () => 'rag', uniqueSlug: async () => { await fs.mkdir(path.join(root, 'rag')); return 'rag'; },
    createRunStore: () => store, configProjection: () => ({ provider: 'test', model: 'test', researchProviders: ['hn'], researchMode: 'mock', brandStyle: 'none', limits: cfg.limits }),
    newRun: o => ({ schemaVersion: 1, runId: 'run', slug: o.slug, command: o.command, topic: o.topic, status: 'running', startedAt: '2026-01-01T00:00:00.000Z', config: {}, budget: { maxModelCalls: 10, modelCallsUsed: 0 }, steps: [], modelCalls: [], sources: [], claims: [], criticImages: [], artifacts: {}, gates: {} }),
    schema: step => ({ $id: step }), buildPrompt: (step, context) => ({ system: step, messages: [{ role: 'user', content: JSON.stringify(context) }] }), resourceHashes: () => ({ exemplars: [], sceneSchema: 'scene', contract: 'contract', defaults: 'defaults', fonts: [], renderer: [] }),
    browserIdentity: () => ({ browserVersion: 'browser', playwrightVersion: 'playwright' }), repair: () => [], inspect: async scene => ({ ok: ++sceneCalls > 1, scene: clone(scene), errors: sceneCalls === 1 ? [{ path: '/nodes/1', message: 'Overlapping nodes: node-0, node-1' }] : [] }),
    render: async (scene, dir) => { const gifPath = path.join(dir, 'result.gif'), manifestPath = path.join(dir, 'steps', 'render.json'); await fs.mkdir(path.dirname(manifestPath), { recursive: true }); await fs.writeFile(gifPath, 'gif'); await fs.writeFile(manifestPath, '{}'); return { gifPath, manifestPath, quality: { ok: true, failures: [], metrics: { loopSeamOk: true, flickerPixelCount: 0 } } }; },
    assertQuality: () => {}, createCriticImages: async () => [], critic: async () => ({ verdict: 'pass', checks: { readability: 'pass', overlap: 'pass', seam: 'pass', motion: 'pass', hook: 'pass', brand: 'pass' } }), rankCandidates: value => value,
    createCompleter: ({ run }) => async request => {
      if (request.step === 'research') return { value: clone(sheet) };
      if (request.step === 'brief') return { value: clone(brief) };
      if (request.step === 'scene') { prompts.push({ context: JSON.parse(request.messages[0].content), deferSceneValidation: request.deferSceneValidation }); run.budget.modelCallsUsed++; return { value: clone(prompts.length === 1 ? initial : corrected) }; }
      throw new Error('Unexpected request ' + request.step);
    }
  };
  const result = await createHarness(d).runMake('RAG');
  assert.equal(result.run.status, 'delivered'); assert.equal(prompts.length, 2); assert.equal(prompts[1].deferSceneValidation, true);
  assert.deepEqual(prompts[1].context.previousProposal, initial); assert.deepEqual(prompts[1].context.errors, [{ path: '/nodes/1', message: 'Overlapping nodes: node-0, node-1' }]);
  assert.deepEqual(prompts[1].context.uncoveredSubstantiveTexts, []); assert.equal(Object.hasOwn(prompts[1].context, 'candidate'), false);
  assert.deepEqual(result.run.autoAuthoringSlots, [{ path: '/edges/0/label/text', text: 'chunk + embed', supports: ['authoring'] }]);
});

test('scene and repair prompts expose the deterministic authoring contract', () => {
  const scene = buildPrompt('scene', {}).system;
  const repair = buildPrompt('repair', {}).system;
  for (const text of ['laptop, monitor, server', 'mongodb, redis, postgresql', 'exactly one of `cyclesPerLoop` or `speedPxPerSec`', 'Retrieve documents', 'chunk + embed', 'RAG combines search with generation.', 'RAG: search + generation', '16 px', '32..768']) assert.match(scene, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(repair, /MINIMAL EDIT/); assert.match(repair, /previousProposal/); assert.match(repair, /Keep every existing ID/);
});
