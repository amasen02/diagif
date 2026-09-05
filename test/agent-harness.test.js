'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('../src/fs-atomic.js');
const { createHarness } = require('../src/agent/harness.js');
const { collectDiagramText, claimsCover, resolvePointer } = require('../src/agent/claims.js');
const { deterministicRepair } = require('../src/agent/scene-repair.js');
const { heuristicCritic, critic, createCriticImages } = require('../src/agent/critic.js');
const { renderAgentScene, assertQualityGate, verifyRenderArtifacts, restorePromotedArtifacts } = require('../src/agent/render.js');
const { validateAndInspect } = require('../src/agent/scene-inspect.js');
const { AgentSchemaError, AgentBudgetExhausted, AgentQuotaError, AgentResearchInsufficient, AgentResumeMismatch } = require('../src/agent/errors.js');

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
const hash = (...values) => createHash('sha256').update(JSON.stringify(canonical(values.length === 1 ? values[0] : values))).digest('hex');
const clone = value => structuredClone(value);
const checks = () => ({ readability: 'pass', overlap: 'pass', seam: 'pass', motion: 'pass', hook: 'pass', brand: 'pass' });
function authoredScene() {
  return { id: 'proposal-id', title: { text: 'Retrieve before generating' }, canvas: { width: 800, height: 1000 }, layout: { kind: 'freeform' },
    nodes: Array.from({ length: 5 }, (_, i) => ({ id: 'node-' + i, label: 'Step ' + i, x: 80, y: 200 + i * 130, w: 180, h: 80 })),
    edges: [], annotations: [], timeline: { durationMs: 4000, fps: 25, animations: [{ kind: 'pulse', nodeIds: ['node-0'], cyclesPerLoop: 2 }] } };
}
function proposal() {
  const scene = authoredScene();
  return { scene, claims: collectDiagramText(scene).map(s => ({ ...s, supports: ['fact-1'] })), authoringNotes: [] };
}
function fakeStore(root) {
  const writeJson = async (file, value) => { await writeFileAtomic(path.join(root, file), JSON.stringify(value)); return { outputPath: file, outputHash: hash(value) }; };
  return { root, persist: run => writeJson('run.json', run), writeJson,
    writeText: (file, text) => writeFileAtomic(path.join(root, file), text),
    loadRun: async () => JSON.parse(await fs.readFile(path.join(root, 'run.json'), 'utf8')),
    persistStep: async (name, value, metadata) => ({ name, status: 'success', ...metadata, ...await writeJson('steps/' + name + '.json', value) }),
    reusableStep: async (run, name, inputHash) => {
      const old = [...run.steps].reverse().find(s => s.name === name && ['success', 'reused'].includes(s.status) && s.accepted !== false && s.inputHash === inputHash);
      if (!old) return null;
      try {
        const value = JSON.parse(await fs.readFile(path.join(root, old.outputPath), 'utf8'));
        return hash(value) === old.outputHash ? { ...old, value, status: 'reused' } : null;
      } catch { return null; }
    }
  };
}

async function fixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'diagif-d-'));
  const cfg = { configDir: root, brain: {}, research: { providers: ['hn', 'github', 'page'] },
    limits: { maxModelCalls: options.maxModelCalls || 28, maxOutputTokens: Object.fromEntries(['research', 'brief', 'scene', 'critic', 'scout'].map(k => [k, 1000])),
      modelTimeoutMs: Object.fromEntries(['research', 'brief', 'scene', 'critic', 'scout'].map(k => [k, 180000])),
      runTimeoutMs: 1800000, researchDeadlineMs: 90000, inspectTimeoutMs: 60000, renderTimeoutMs: 900000 } };
  const source = { id: 'src-example', url: 'https://example.org/rag', title: 'How retrieval works', provider: 'hn', publishedAt: '2026-09-01T00:00:00Z', engagement: { score: 10, comments: 2 } };
  const sheet = { topic: 'explain RAG', retrievedAt: '2026-09-05T00:00:00Z', sources: [source],
    facts: Array.from({ length: 6 }, (_, i) => ({ id: 'fact-' + (i + 1), sourceId: source.id, statement: 'Statement number ' + i, quote: 'Retrieval finds relevant source documents ' + i })) };
  const brief = { topic: sheet.topic, angle: 'Explain retrieval before generation', hook: 'Retrieve before generating', format: 'how-it-works', factIds: ['fact-1', 'fact-2', 'fact-3'],
    post: { hook: 'Retrieve before generating', lines: ['Find relevant passages.', 'Supply source context.', 'Generate a grounded answer.'], cta: 'Save this explanation.', hashtags: ['#RAG', '#AI'] } };
  const counters = { requests: [], inspections: 0, renders: 0, critics: 0, collections: 0, proposed: 0 };
  const d = { hash, hashFile: async file => hash(await fs.readFile(file, 'utf8')), loadConfig: () => clone(cfg),
    selectBrain: () => ({ name: 'test', provider: 'test', model: 'fixture', capability: { vision: true } }),
    selectResearch: () => ({ collect: async () => { counters.collections++; return { sources: [source], extracts: [{ sourceId: source.id, url: source.url, text: options.sourceText || 'retrieval evidence' }], diagnostics: [] }; } }),
    assertGrounded: value => { if (options.groundingError) throw new AgentResearchInsufficient('insufficient evidence'); return value; },
    slugify: topic => topic.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    uniqueSlug: async (base, out) => { let slug = base; for (let i = 2; ; i++) { try { await fs.access(path.join(out, slug)); slug = base + '-' + i; } catch { return slug; } } },
    resolveResume: async (out, topic, slug) => {
      const candidates = [];
      for (const dir of await fs.readdir(out)) {
        try { const run = await fakeStore(path.join(out, dir)).loadRun(); if (run.topic === topic && (!slug || slug === dir)) candidates.push(dir); } catch {}
      }
      if (candidates.length !== 1) throw new AgentResumeMismatch('ambiguous run', { details: candidates }); return candidates[0];
    },
    createRunStore: root => fakeStore(root),
    configProjection: (config, brain, opts) => ({ provider: brain.provider, model: brain.model, researchProviders: config.research.providers, researchMode: opts.researchMode, brandStyle: config.brand?.style || 'none', limits: config.limits }),
    newRun: o => ({ schemaVersion: 1, runId: randomUUID(), slug: o.slug, topic: o.topic, command: o.command, status: 'running', startedAt: new Date().toISOString(),
      ...(o.parentSlug ? { parentSlug: o.parentSlug } : {}), config: {}, budget: { maxModelCalls: o.config.limits.maxModelCalls, modelCallsUsed: 0 },
      steps: [], modelCalls: [], sources: [], claims: [], criticImages: [], artifacts: {}, gates: {} }),
    schema: step => ({ $id: 'stub:' + step }), buildPrompt: (step, context) => ({ system: step, messages: [{ role: 'user', content: JSON.stringify(context) }] }),
    resourceHashes: () => ({ exemplars: ['exemplar'], sceneSchema: 'schema', contract: 'contract', defaults: 'defaults', fonts: ['font'], renderer: ['renderer'] }),
    browserIdentity: () => ({ browserVersion: 'test', playwrightVersion: 'test' }), repair: () => [],
    inspect: async scene => { counters.inspections++; const ok = !options.sceneExhaust && counters.inspections > (options.rejectProposals || 0); return { ok, scene: clone(scene), brand: { ok: true }, errors: ok ? [] : [{ path: '/nodes', message: 'overlap' }] }; },
    render: async (scene, dir, attempt) => {
      counters.renders++;
      const gifPath = path.join(dir, scene.id + '.gif'), contactSheet = gifPath + '.contact.png';
      const entry = { status: 'ok', quality: { ok: true, failures: [], metrics: { loopSeamOk: true, flickerPixelCount: 0 } }, identicalRanges: [] };
      const value = { exitCode: 0, entry, quality: entry.quality, gifPath, contactSheet, manifestPath: path.join(dir, 'steps', '04-render-a' + attempt + '.manifest.json') };
      await writeFileAtomic(gifPath, 'verified attempt ' + attempt); await writeFileAtomic(contactSheet, 'contact ' + attempt);
      await writeFileAtomic(value.manifestPath, JSON.stringify(value)); return value;
    }, assertQuality: assertQualityGate,
    createCriticImages: async (rendered, dir) => { const file = path.join(dir, 'frames.png'); await writeFileAtomic(file, 'frame tile ' + path.basename(dir)); return [file]; },
    critic: async context => { counters.critics++; return context.complete({ images: context.images, measured: { pass: true } }); },
    rankCandidates: candidates => candidates.map((c, i) => ({ ...c, virality: 80 - i }))
  };
  // A contract stub for Job A's retrying runner. No Job A code is imported.
  d.createCompleter = ({ run, store, persist, aggregateBudget }) => async request => {
    const attempts = options.threeAttempts ? 3 : 1;
    for (let i = 1; i <= attempts; i++) {
      if (run.budget.modelCallsUsed >= run.budget.maxModelCalls || aggregateBudget && aggregateBudget.modelCallsUsed >= aggregateBudget.maxModelCalls) throw new AgentBudgetExhausted('budget exhausted');
      run.budget.modelCallsUsed++;
      if (aggregateBudget) aggregateBudget.modelCallsUsed++;
      run.modelCalls.push({ step: request.step, attempt: i, structured: true });
      await persist();
      const durable = await store.loadRun();
      assert.equal(durable.budget.modelCallsUsed, run.budget.modelCallsUsed, 'counter must be durable before the provider request');
      assert.ok(durable.steps.some(s => s.status === 'running'), 'step running transition must precede request');
      counters.requests.push(request.step);
      if (options.providerError) throw new AgentQuotaError('quota fixture');
      if (i < attempts) continue;
      let value;
      if (request.step === 'research') value = clone(sheet);
      else if (request.step === 'brief') { value = clone(brief); if (options.post) value.post = clone(options.post); }
      else if (request.step === 'scene') { counters.proposed++; if (options.schemaExhaust) throw new AgentSchemaError('invalid proposal'); value = proposal(); if (options.missingClaims) value.claims = []; }
      else if (request.step === 'critic') value = { mode: 'vision', verdict: options.criticRepair && counters.critics === 1 || options.finalRepair ? 'repair' : 'pass', checks: checks(), edits: [] };
      else if (request.step === 'scout') value = { domain: 'software', generatedAt: sheet.retrievedAt, candidates: ['explain RAG', 'REST API optimisation techniques'].map(topic => ({ topic, title: topic, sourceIds: [source.id], rationale: 'fixture', signals: { recency: 0, score: 0, comments: 0 }, virality: 0 })) };
      await request.postValidate?.(value); return { value };
    }
  };
  return { root, cfg, counters, d, harness: createHarness(d) };
}

test('brief drafting persists a consistent caption without another model call', async () => {
  const f = await fixture({ post: { hook: 'Six stages of RAG', lines: ['1. Retrieve', '2. Rank', '3. Augment', '4. Generate'], cta: 'Trace these six stages.', hashtags: ['#RAG'] } });
  const result = await f.harness.runMake('explain RAG', { dryRun: true });
  const caption = await fs.readFile(path.join(result.runDir, 'post.md'), 'utf8');
  const brief = JSON.parse(await fs.readFile(path.join(result.runDir, 'steps/02-brief.json'), 'utf8'));
  assert.match(caption, /4 stages of RAG/); assert.match(caption, /Trace these 4 stages\./);
  assert.equal(brief.post.cta, 'Trace these 4 stages.');
  assert.deepEqual(f.counters.requests, ['research', 'brief']);
});

test('injected happy path writes every deliverable, source and claim with durable budget-before-request', async () => {
  const f = await fixture(), result = await f.harness.runMake('explain RAG');
  assert.equal(result.run.status, 'delivered'); assert.equal(result.run.budget.modelCallsUsed, 4);
  for (const file of ['explain-rag.gif', 'explain-rag.gif.contact.png', 'post.md', 'run.json', 'scene.json']) await fs.access(path.join(result.runDir, file));
  assert.equal(result.run.claims.length, collectDiagramText(authoredScene()).length);
  assert.equal(result.run.sources.length, 1); assert.equal(result.run.criticImages.length, 1);
  assert.equal(f.counters.proposed, 1);
});

test('27-call worst case fits 28 and retains both render manifests after a critic repair', async () => {
  const f = await fixture({ threeAttempts: true, rejectProposals: 3, criticRepair: true });
  const result = await f.harness.runMake('explain RAG');
  assert.equal(result.run.budget.modelCallsUsed, 27); assert.equal(result.run.budget.maxModelCalls, 28);
  assert.equal(f.counters.requests.length, 27); assert.equal(f.counters.proposed, 5); assert.equal(f.counters.critics, 2);
  assert.equal(result.run.status, 'delivered');
  for (const name of ['03-scene-a4.json', '03-scene-a5.json', '04-render-a1.manifest.json', '04-render-a2.manifest.json', '05-critic-a2.json']) {
    const value = JSON.parse(await fs.readFile(path.join(result.runDir, 'steps', name), 'utf8')); assert.ok(value);
  }
  assert.equal(await fs.readFile(path.join(result.runDir, 'explain-rag.gif'), 'utf8'), 'verified attempt 2');
});

test('final critic audit never opens a third render or sixth proposal', async () => {
  const f = await fixture({ criticRepair: true, finalRepair: true }), result = await f.harness.runMake('explain RAG');
  assert.equal(f.counters.renders, 2); assert.equal(f.counters.proposed, 2); assert.equal(result.run.status, 'delivered-with-warnings');
});

test('dry run stops after fact sheet, brief and post; no scene/render/critic work', async () => {
  const f = await fixture(), result = await f.harness.runMake('explain RAG', { dryRun: true });
  assert.deepEqual(f.counters.requests, ['research', 'brief']); assert.equal(result.run.status, 'delivered');
  assert.equal(f.counters.inspections + f.counters.renders + f.counters.critics, 0);
  assert.equal(result.run.artifacts.sceneJson, undefined);
  await assert.rejects(fs.access(path.join(result.runDir, 'scene.json')), { code: 'ENOENT' });
});

for (const mode of ['sceneExhaust', 'schemaExhaust', 'missingClaims']) test(mode + ' retains all four rejected proposals and maps to exit 4', async () => {
  const f = await fixture({ [mode]: true });
  await assert.rejects(f.harness.runMake('explain RAG'), error => {
    assert.equal(error.code, 'SCENE_REPAIR_EXHAUSTED'); assert.equal(error.exitCode, 4);
    assert.equal(error.run.steps.filter(s => /^03-scene/.test(s.name)).length, 4);
    assert.ok(error.run.steps.filter(s => /^03-scene/.test(s.name)).every(s => s.accepted === false)); return true;
  });
  assert.equal(f.counters.renders, 0);
  for (let i = 1; i <= 4; i++) await fs.access(path.join(f.root, 'out/explain-rag/steps/03-scene-a' + i + '.json'));
});

test('budget exhaustion persists exact cap, typed error and failed step before returning', async () => {
  const f = await fixture({ maxModelCalls: 2 });
  await assert.rejects(f.harness.runMake('explain RAG'), { code: 'BUDGET_EXHAUSTED', exitCode: 6 });
  const run = await fakeStore(path.join(f.root, 'out/explain-rag')).loadRun();
  assert.equal(run.budget.modelCallsUsed, 2); assert.equal(run.status, 'failed'); assert.equal(run.error.code, 'BUDGET_EXHAUSTED');
  assert.equal(f.counters.requests.length, 2);
});

for (const [mode, code] of [['providerError', 'PROVIDER_QUOTA'], ['groundingError', 'RESEARCH_INSUFFICIENT']]) test(code + ' persists typed failure without continuing', async () => {
  const f = await fixture({ [mode]: true });
  await assert.rejects(f.harness.runMake('explain RAG'), { code });
  const run = await fakeStore(path.join(f.root, 'out/explain-rag')).loadRun();
  assert.equal(run.error.code, code); assert.equal(f.counters.proposed, 0);
});

test('matching resume reuses hashes; brand change invalidates scene onward only; fresh restarts research', async () => {
  const f = await fixture();
  const first = await f.harness.runMake('explain RAG');
  const matching = await f.harness.runMake('explain RAG', { resumeSlug: first.slug });
  assert.equal(matching.run.budget.modelCallsUsed, first.run.budget.modelCallsUsed);
  assert.ok(matching.run.steps.slice(first.run.steps.length).every(s => s.status === 'reused'));
  f.cfg.brand = { style: 'url-footer', url: 'https://www.linkedin.com/in/example' };
  const changed = await f.harness.runMake('explain RAG', { resumeSlug: first.slug });
  const steps = changed.run.steps.slice(matching.run.steps.length);
  assert.deepEqual(steps.slice(0, 2).map(s => s.status), ['reused', 'reused']);
  assert.ok(steps.slice(2).every(s => s.status === 'success'));
  const fresh = await f.harness.runMake('explain RAG', { resumeSlug: first.slug, fresh: true });
  assert.ok(fresh.run.steps.slice(changed.run.steps.length).every(s => s.status === 'success'));
});

test('source text and browser changes invalidate their own hash frontier', async () => {
  const settings = {}, f = await fixture(settings), first = await f.harness.runMake('explain RAG');
  f.d.browserIdentity = () => ({ browserVersion: 'new', playwrightVersion: 'new' });
  const browser = await f.harness.runMake('explain RAG', { resumeSlug: first.slug });
  assert.deepEqual(browser.run.steps.slice(first.run.steps.length, first.run.steps.length + 2).map(s => s.status), ['reused', 'reused']);
  settings.sourceText = 'changed source evidence';
  const source = await f.harness.runMake('explain RAG', { resumeSlug: first.slug });
  assert.equal(source.run.steps[browser.run.steps.length].status, 'success');
});

test('ambiguous resume reports mismatch; tampered step output is never reused', async () => {
  const f = await fixture(), first = await f.harness.runMake('explain RAG', { dryRun: true });
  await f.harness.runMake('explain RAG', { dryRun: true });
  await assert.rejects(f.harness.runMake('explain RAG', { resume: true }), { code: 'RESUME_MISMATCH' });
  await writeFileAtomic(path.join(first.runDir, 'steps/02-brief.json'), '{"tampered":true}');
  const next = await f.harness.runMake('explain RAG', { resumeSlug: first.slug, dryRun: true });
  assert.deepEqual(next.run.steps.slice(first.run.steps.length).map(s => s.status), ['reused', 'success']);
});

test('scout makes children serially with parentSlug and prints heuristic score table', async () => {
  const f = await fixture(), logs = [];
  const result = await f.harness.runScout({ make: true, count: 2, log: line => logs.push(line) });
  assert.equal(result.children.length, 2); assert.ok(result.children.every(c => c.run.parentSlug === result.slug));
  assert.equal(new Set(result.children.map(c => c.runDir)).size, 2); assert.match(logs[0], /heuristic virality/);
  assert.match(logs[1], /^1 \| 80/);
});

test('scout aggregate cap includes scout and prevents excess child requests', async () => {
  const f = await fixture();
  await assert.rejects(f.harness.runScout({ make: true, count: 2, maxTotalModelCalls: 4, log: () => {} }), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(f.counters.requests.length, 4);
});

test('scout retries also obey the aggregate cap before children exist', async () => {
  const f = await fixture({ threeAttempts: true });
  await assert.rejects(f.harness.runScout({ maxTotalModelCalls: 2, count: 2, log: () => {} }), { code: 'BUDGET_EXHAUSTED' });
  assert.equal(f.counters.requests.length, 2);
});

test('substantive diagram text slots are reported when unmapped; connectives auto-cover and unmatched claims and fact IDs are rejected', () => {
  const scene = { title: { text: 'title', subtitle: { text: 'subtitle' } }, layout: { labels: ['label'], sections: [{ header: 'section' }], columns: [{ header: 'column' }],
    mindmap: { root: { label: 'root' }, branches: [{ label: 'branch', leaves: [{ label: 'leaf' }] }] } },
    nodes: [{ label: 'node', secondaryLabel: 'secondary' }], edges: [{ label: { text: 'edge' } }],
    annotations: [{ text: 'annotation', lines: [{ text: 'code' }], header: ['header'], rows: [['cell']] }],
    timeline: { animations: [{ kind: 'typing', text: 'typed' }] } };
  const slots = collectDiagramText(scene); assert.equal(slots.length, 16);
  const missing = claimsCover(scene, [], { facts: [] });
  assert.deepEqual(missing.errors.map(e => e.path).sort(), slots.filter(s => !/^\/(layout\/(labels|sections|columns)|edges)\//.test(s.path)).map(s => s.path).sort());
  assert.equal(missing.autoAuthoringSlots.length, 4);
  const claims = slots.map(s => ({ ...s, supports: ['authoring'] }));
  assert.equal(claimsCover(scene, claims, { facts: [] }).ok, true);
  claims.push({ path: '/__proto__/constructor', text: 'bad', supports: ['fact-unknown'] });
  const bad = claimsCover(scene, claims, { facts: [] }); assert.equal(bad.ok, false); assert.equal(bad.errors.length, 2);
  assert.equal(resolvePointer({ 'a/b': { '~': 'escaped' } }, '/a~1b/~0'), 'escaped');
  assert.equal(resolvePointer({}, '/bad~2escape'), undefined);
});

test('repair shortens node labels deterministically and clamps/nudges with a bounded logged trace', () => {
  const scene = authoredScene(); scene.nodes[0].label = 'The very long label (extra context), additional clause, last clause';
  scene.nodes[0].x = 10.4; scene.nodes[0].y = 960; scene.nodes[0].h = 32; scene.nodes[1].y = scene.nodes[0].y;
  const input = clone(scene), opts = { validate: () => ({ valid: true, errors: [] }), measureLines: text => text.length > 18 ? 3 : 1, zone: { x: 32, y: 160, w: 736, h: 840, bottom: 1000 } };
  const trace = deterministicRepair(scene, opts), copy = clone(input);
  assert.deepEqual(trace, deterministicRepair(copy, opts)); assert.deepEqual(scene, copy);
  assert.ok(trace.some(e => e.rule === 'label-overflow')); assert.ok(trace.some(e => e.rule === 'out-of-zone'));
  assert.ok(trace.penalties.length <= 3);
  assert.ok(trace.every(e => Object.hasOwn(e, 'old') && Object.hasOwn(e, 'new') && e.path));
  assert.ok(scene.nodes[0].label.length <= 18);
  assert.ok(scene.nodes[0].label.split(/\s+/).length >= 3);
});

test('materialized mindmap coverage follows authored tree paths and never invents generated-node claims', () => {
  const scene = { title: { text: 'Map' }, layout: { kind: 'mindmap', mindmap: {
    root: { label: 'Root' }, branches: [{ label: 'Branch', leaves: [{ label: 'Leaf' }] }], placement: {}
  } }, nodes: [{ label: 'Root' }, { label: 'Branch' }, { label: 'Leaf' }], edges: [], timeline: { animations: [] } };
  const slots = collectDiagramText(scene);
  assert.equal(slots.length, 4); assert.ok(slots.every(s => !s.path.startsWith('/nodes')));
  assert.equal(claimsCover(scene, slots.map(s => ({ ...s, supports: ['authoring'] })), { facts: [] }).ok, true);
});

test('repair preserves annotation, table, edge, title and typing text for explicit model edits', () => {
  const scene = authoredScene(), long = 'The very long explanation (extra context), additional clause';
  scene.title = { text: long, lines: [long] };
  scene.edges = [{ label: { text: long } }];
  scene.annotations = [{ text: long, lines: [{ text: long }], header: [long], rows: [[long]], w: 200 }];
  scene.timeline.animations.push({ kind: 'typing', targetId: 'node-0', text: long });
  const textBefore = collectDiagramText(scene);
  const trace = deterministicRepair(scene, { validate: () => ({ valid: true, errors: [] }), measureLines: text => text.length > 20 ? 3 : 1,
    zone: { x: 32, y: 160, w: 736, h: 840, bottom: 1000 } });
  assert.deepEqual(scene.title.lines, [long]);
  assert.deepEqual(collectDiagramText(scene), textBefore);
  assert.ok(!trace.some(t => typeof t.old === 'string' && typeof t.new === 'string'));
});

test('heuristic critic marks readability and hook unmeasured and cannot pass gate failures', async () => {
  const context = { scene: authoredScene(), inspection: { ok: true, errors: [], brand: { ok: true } },
    rendered: { entry: { identicalRanges: [] }, quality: { ok: true, failures: [], metrics: { loopSeamOk: true, flickerPixelCount: 0 } } } };
  const happy = heuristicCritic(context); assert.equal(happy.verdict, 'pass'); assert.equal(happy.checks.readability, 'unmeasured'); assert.equal(happy.checks.hook, 'unmeasured');
  context.rendered.quality.metrics.flickerPixelCount = 1;
  assert.equal(heuristicCritic(context).verdict, 'repair');
  const reviewed = await critic({ ...context, brain: { capability: { vision: true } }, images: ['bounded.png'], complete: async () => ({ mode: 'vision', verdict: 'pass', checks: checks(), edits: [] }) });
  assert.equal(reviewed.verdict, 'repair'); assert.equal(reviewed.checks.seam, 'fail');
  const unavailable = await critic({ ...context, brain: { capability: { vision: true } }, images: [], complete: async () => { throw new AgentQuotaError('unavailable'); } });
  assert.equal(unavailable.mode, 'heuristic'); assert.equal(unavailable.checks.readability, 'unmeasured');
});

test('critic image subprocess uses a real Python executable and argument array without a contact sheet', async () => {
  let args;
  const result = await createCriticImages({ framesDir: '/frames', contactSheet: '/forbidden-contact.png' }, '/tiles', {
    pythonResolver: async () => ({ command: '/python', args: [] }), processRunner: async (command, argv) => { assert.equal(command, '/python'); args = argv; return { code: 0, stdout: '{"images":["/tiles/frames.png"]}', stderr: '' }; }
  });
  assert.deepEqual(result, ['/tiles/frames.png']); assert.ok(Array.isArray(args)); assert.ok(!args.includes('/forbidden-contact.png'));
});

test('render adapter routes exact attempt roots and keeps passing sidecars and GIF snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagif-render-'));
  const stages = { capture() {}, encode() {}, verify() {} }, seen = [];
  const runBatch = async (inputs, wrapped, options) => {
    seen.push(options); assert.equal(inputs.length, 1); assert.equal(typeof wrapped.capture, 'function');
    const gif = path.join(dir, 'proposal-id.gif');
    for (const suffix of ['', '.contact.png', '.quality.json', '.encode.json']) await writeFileAtomic(gif + suffix, 'attempt-' + seen.length);
    const manifest = { scenes: [{ status: 'ok', primaryPath: gif, contactSheet: gif + '.contact.png', quality: { ok: true, failures: [], metrics: {} } }] };
    await writeFileAtomic(options.manifestPath, JSON.stringify(manifest));
    return { exitCode: 0, manifest, manifestPath: options.manifestPath };
  };
  let last;
  for (const attempt of [1, 2]) last = await renderAgentScene(authoredScene(), dir, attempt, { runBatch, stages, reservedColors: [] });
  for (const [i, options] of seen.entries()) {
    assert.equal(options.outputDir, dir); assert.equal(options.workRoot, path.join(dir, 'work', 'a' + (i + 1)));
    assert.equal(path.basename(options.manifestPath), '04-render-a' + (i + 1) + '.manifest.json');
    assert.equal(await fs.readFile(path.join(dir, 'steps', '04-render-a' + (i + 1), 'proposal-id.gif'), 'utf8'), 'attempt-' + (i + 1));
  }
  assert.equal(await verifyRenderArtifacts(last), true);
  const escaped = clone(last); escaped.artifactHashes[0].promoted = path.join(dir, '..', 'escaped.gif');
  assert.equal(await verifyRenderArtifacts(escaped, dir), false);
  await assert.rejects(restorePromotedArtifacts(escaped, dir), { code: 'QUALITY_GATE' });
  await writeFileAtomic(last.gifPath, 'corrupted promoted GIF');
  await restorePromotedArtifacts(last);
  assert.equal(await fs.readFile(last.gifPath, 'utf8'), 'attempt-2');
  await writeFileAtomic(last.artifactHashes[0].evidence, 'corrupted evidence');
  assert.equal(await verifyRenderArtifacts(last), false);
  await assert.rejects(restorePromotedArtifacts(last), { code: 'QUALITY_GATE' });
});

test('scene inspector propagates structural failures without opening Chromium', async () => {
  let opened = false;
  const result = await validateAndInspect({}, { open: async () => { opened = true; }, normalize: value => value,
    validate: scene => ({ valid: false, scene, errors: [{ path: '/nodes', message: 'invalid nodes' }] }) });
  assert.equal(result.ok, false); assert.equal(opened, false); assert.deepEqual(result.errors, [{ path: '/nodes', message: 'invalid nodes' }]);
});

test('scene inspector enforces its deadline and closes a browser that opens late', async () => {
  let closed = 0;
  const result = await validateAndInspect({}, { timeoutMs: 5, normalize: value => value, validate: scene => ({ valid: true, scene }),
    open: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return { close: async () => { closed++; } }; } });
  assert.equal(result.ok, false); assert.match(result.errors[0].message, /timed out/);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(closed, 1);
});

test('render deadline blocks later stages and maps to render exit 5', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diagif-deadline-'));
  let encoded = false;
  const stages = { capture: () => new Promise(resolve => setTimeout(() => resolve({}), 30)), encode: () => { encoded = true; }, verify() {} };
  await assert.rejects(renderAgentScene(authoredScene(), dir, 1, { timeoutMs: 5, stages, reservedColors: [],
    runBatch: async (inputs, bounded) => { await bounded.capture({}); await bounded.encode({}); }
  }), error => error.code === 'RENDER' && error.exitCode === 5 && /deadline/.test(error.message));
  assert.equal(encoded, false);
  await assert.rejects(fs.access(path.join(dir, 'proposal-id.gif')), { code: 'ENOENT' });
});

test('harness unit tests never load provider transports or research orchestration', () => {
  const loaded = Object.keys(require.cache);
  assert.ok(!loaded.some(file => /src[\\/]agent[\\/](brains|research[\\/]index|config|run-store|virality)/.test(file)));
  assert.ok(!loaded.some(file => /src[\\/](schema\.js|normalize-scene\.js|renderer[\\/]layout\.js)$/.test(file)));
});
