'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { validateValue } = require('../src/agent/brains/schema');
const { validateScene } = require('../src/schema');
const { claimsCover } = require('../src/agent/claims');
const { rankCandidates } = require('../src/agent/virality');
const ROOT = path.resolve(__dirname, '..');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// This preload observes the actual CLI process, before any application imports.
const GUARD = String.raw`
const fs = require('node:fs'), path = require('node:path');
const cp = require('node:child_process'), dns = require('node:dns');
const report = { fetch: 0, dns: 0, http: 0, spawns: [] };
globalThis.fetch = () => { report.fetch++; throw new Error('Offline fetch attempted'); };
dns.lookup = () => { report.dns++; throw new Error('Offline DNS attempted'); };
dns.promises.lookup = async () => { report.dns++; throw new Error('Offline DNS attempted'); };
for (const name of ['node:http', 'node:https']) for (const method of ['request', 'get']) {
  require(name)[method] = () => { report.http++; throw new Error('Offline HTTP attempted'); };
}
for (const method of ['spawn', 'spawnSync']) {
  const original = cp[method];
  cp[method] = function(command, args, options) {
    const name = path.basename(command).toLowerCase();
    const allowed = /^(chrome|chromium|chrome-headless-shell|headless_shell|python(?:3(?:\.\d+)?)?|py)(\.exe)?$/.test(name);
    report.spawns.push({ name, shell: options?.shell ?? false, allowed });
    if (!allowed || options?.shell || !Array.isArray(args)) throw new Error('Forbidden subprocess: ' + name);
    return original.call(this, command, args, options);
  };
}
process.on('exit', () => fs.writeFileSync(process.env.DIAGIF_GUARD_REPORT, JSON.stringify(report)));
`;

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('offline CLI acceptance with real research, brains, renderer, gates and durable artifacts', { timeout: 1800000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-acceptance-'));
  const guard = path.join(root, 'offline-guard.cjs');
  fs.writeFileSync(guard, GUARD);
  t.diagnostic('Retained acceptance artifacts: ' + root);
  const env = { ...process.env, DIAGIF_OFFLINE: '1' };
  let invocation = 0;
  async function cli(args, expected = 0, cwd = root, entry = 'bin/diagif.js') {
    const report = path.join(root, 'guard-' + (++invocation) + '.json');
    const result = await execute(process.execPath, ['--require', guard, path.join(ROOT, entry), ...args], {
      cwd, env: { ...env, DIAGIF_GUARD_REPORT: report }, timeout: 900000
    });
    fs.writeFileSync(path.join(root, 'command-' + invocation + '.json'), JSON.stringify({ args, ...result }, null, 2));
    t.diagnostic(JSON.stringify({ command: 'node ' + entry, args, ...result }));
    assert.equal(result.code, expected, result.stderr + result.stdout);
    const observed = json(report);
    assert.equal(observed.fetch + observed.dns + observed.http, 0, JSON.stringify(observed));
    assert.ok(observed.spawns.every(s => s.allowed && !s.shell), JSON.stringify(observed));
    return { ...result, observed };
  }
  function runAt(out, slug) {
    const dir = path.join(out, slug), run = json(path.join(dir, 'run.json'));
    validateValue(require('../src/agent/schemas/run.schema.json'), run);
    assert.doesNotMatch(JSON.stringify(run.config), /(?:sk-[A-Za-z0-9]{8,}|Bearer\s|BEGIN PRIVATE KEY)/); // sanitize-allow: checks secret-shaped output without real credentials
    return { dir, run };
  }
  function delivery(out, slug, height = 1000) {
    const result = runAt(out, slug), { dir, run } = result;
    assert.equal(run.status, 'delivered-with-warnings');
    for (const name of [slug + '.gif', slug + '.gif.contact.png', 'post.md', 'scene.json', 'steps']) assert.ok(fs.existsSync(path.join(dir, name)), name);
    const scene = json(path.join(dir, 'scene.json'));
    const sheet = json(path.join(dir, run.artifacts.factSheet));
    const brief = json(path.join(dir, run.artifacts.brief));
    const post = fs.readFileSync(path.join(dir, 'post.md'), 'utf8');
    assert.ok(brief.post.lines.length >= 3 && brief.post.lines.length <= 5);
    for (const line of [brief.post.hook, ...brief.post.lines, brief.post.cta, brief.post.hashtags.join(' ')]) assert.ok(post.includes(line));
    assert.equal(claimsCover(scene, run.claims, sheet).ok, true);
    const quality = json(path.join(dir, slug + '.gif.quality.json'));
    assert.deepEqual(quality.failures, []);
    assert.equal(quality.loopSeamOk, true);
    const gif = fs.readFileSync(path.join(dir, slug + '.gif'));
    assert.match(gif.subarray(0, 6).toString(), /^GIF8[79]a$/);
    assert.equal(gif.readUInt16LE(6), 800); assert.equal(gif.readUInt16LE(8), height);
    const render = json(path.join(dir, [...run.steps].reverse().find(s => s.name.startsWith('04-render')).outputPath));
    assert.equal(render.entry.encoder, 'pillow');
    assert.ok(new Set(render.entry.frameHashes).size > 1, 'render contains motion');
    assert.equal(sha(path.join(render.entry.framesDir, 'frame_0000.png')), sha(render.entry.seamPath));
    return { ...result, scene, render };
  }
  const out = path.join(root, 'out');
  let first, matching, changed;
  await t.test('mock make exits zero with offline-only processes and every deliverable', async () => {
    const result = await cli(['make', 'explain RAG', '--brain', 'mock', '--out', out]);
    assert.ok(result.observed.spawns.some(s => /chrome|chromium|headless/.test(s.name)));
    assert.ok(result.observed.spawns.some(s => /python|py/.test(s.name)));
    first = delivery(out, 'explain-rag').run;
  });
  await t.test('dry run ends after research and brief', async () => {
    await cli(['make', 'REST API optimisation techniques', '--brain', 'mock', '--dry-run', '--out', out]);
    const { dir, run } = runAt(out, 'rest-api-optimisation-techniques');
    assert.deepEqual(run.steps.map(s => s.name), ['01-research', '02-brief']);
    for (const name of ['factSheet', 'brief', 'postMd']) assert.ok(fs.existsSync(path.join(dir, run.artifacts[name])));
    assert.ok(!fs.existsSync(path.join(dir, 'scene.json'))); assert.ok(!fs.existsSync(path.join(dir, 'work')));
  });
  const brandDir = path.join(root, 'brand');
  fs.mkdirSync(brandDir);
  const config = path.join(brandDir, 'diagif.config.json');
  const url = 'https://www.linkedin.com/in/example';
  await t.test('brand writes only canonical config and invalid host/path leave its bytes intact', async () => {
    await cli(['brand', '--url', url + '/'], 0, brandDir);
    assert.deepEqual(fs.readdirSync(brandDir), ['diagif.config.json']);
    assert.equal(json(config).brand.url, url);
    const before = sha(config);
    for (const bad of ['https://example.org/in/example', 'https://www.linkedin.com/feed/']) {
      await cli(['brand', '--url', bad], 2, brandDir); assert.equal(sha(config), before);
    }
    const copy = path.join(root, 'branded');
    const source = path.join(ROOT, 'scenes/mcp-vs-skills.json'), sourceHash = sha(source);
    await cli([source, '--out', copy, '--config', config], 0, root, 'scripts/apply-brand.js');
    assert.equal(sha(source), sourceHash);
    const { validateAndInspect } = require('../src/agent/scene-inspect');
    const report = await validateAndInspect(json(path.join(copy, 'mcp-vs-skills.json')));
    assert.equal(report.brand.ok, true);
    assert.deepEqual(report.brand.texts.map(s => [s.text, s.fontSize]), [[url, 16]]);
  });
  await t.test('resume reuses exact hashes and brand invalidates scene onward only', async () => {
    assert.ok(first, 'initial delivery required');
    await cli(['make', 'explain RAG', '--brain', 'mock', '--out', out, '--resume-slug', 'explain-rag']);
    matching = runAt(out, 'explain-rag').run;
    assert.equal(matching.budget.modelCallsUsed, first.budget.modelCallsUsed);
    assert.ok(matching.steps.slice(first.steps.length).every(s => s.status === 'reused'));
    await cli(['make', 'explain RAG', '--brain', 'mock', '--out', out, '--resume-slug', 'explain-rag', '--config', config]);
    const delivered = delivery(out, 'explain-rag'); changed = delivered.run;
    const steps = changed.steps.slice(matching.steps.length);
    assert.deepEqual(steps.slice(0, 2).map(s => s.status), ['reused', 'reused']);
    assert.ok(steps.slice(2).every(s => s.status === 'success'));
    const inspection = json(path.join(delivered.dir, steps.find(s => s.name.startsWith('03-scene')).outputPath)).validation;
    assert.deepEqual(inspection.brand.texts.map(s => [s.text, s.fontSize]), [[url, 16]]);
  });
  await t.test('fresh invalidates research and every downstream step', async () => {
    assert.ok(changed, 'brand delivery required');
    await cli(['make', 'explain RAG', '--brain', 'mock', '--out', out, '--resume-slug', 'explain-rag', '--config', config, '--fresh']);
    const fresh = delivery(out, 'explain-rag').run;
    assert.ok(fresh.steps.slice(changed.steps.length).every(s => s.status === 'success'));
  });
  await t.test('mock failure scripts retain retry, repair, rejection and exact budget evidence', async () => {
    for (const [script, code] of [['schema-retry', 0], ['critic-repair', 0], ['scene-exhaust', 4], ['budget', 6]]) {
      const scriptOut = path.join(root, script);
      await cli(['make', 'explain RAG', '--brain', 'mock:' + script, '--out', scriptOut], code);
      const { dir, run } = runAt(scriptOut, 'explain-rag');
      if (script === 'schema-retry') {
        assert.deepEqual(run.modelCalls.filter(c => c.step === 'research').map(c => c.attempt), [1, 2]);
        delivery(scriptOut, 'explain-rag');
      } else if (script === 'critic-repair') {
        for (const step of ['03-scene-a5', '04-render-a2', '05-critic-a2']) assert.ok(run.steps.some(s => s.name === step && s.status === 'success'));
        delivery(scriptOut, 'explain-rag');
      } else if (script === 'scene-exhaust') {
        assert.equal(run.error.code, 'SCENE_REPAIR_EXHAUSTED');
        const proposals = run.steps.filter(s => s.name.startsWith('03-scene'));
        assert.equal(proposals.length, 4);
        for (const proposal of proposals) assert.ok(fs.existsSync(path.join(dir, proposal.outputPath)));
      } else {
        assert.equal(run.error.code, 'BUDGET_EXHAUSTED');
        assert.equal(run.budget.modelCallsUsed, run.budget.maxModelCalls);
        assert.equal(run.modelCalls.length, run.budget.maxModelCalls);
      }
    }
  });
  await t.test('scout uses exact deterministic scores and creates two children with parentSlug', async () => {
    const scoutOut = path.join(root, 'scout');
    const result = await cli(['scout', '--make', '--count', '2', '--brain', 'mock', '--out', scoutOut]);
    assert.match(result.stdout, /rank \| heuristic virality \| topic/);
    const runs = fs.readdirSync(scoutOut).map(slug => runAt(scoutOut, slug));
    const parent = runs.find(r => r.run.command === 'scout'), children = runs.filter(r => r.run.parentSlug);
    assert.equal(children.length, 2); assert.ok(children.every(r => r.run.parentSlug === parent.run.slug));
    const value = json(path.join(parent.dir, parent.run.artifacts.scoutJson));
    const byId = new Map(parent.run.sources.map(s => [s.id, s]));
    const expected = rankCandidates(value.candidates.map(c => ({ ...c, ...byId.get(c.sourceIds[0]), title: c.title })), Date.parse(parent.run.startedAt));
    assert.deepEqual(value.candidates.map(c => [c.topic, c.virality]), expected.map(c => [c.topic, c.virality]));
    for (const child of children) delivery(scoutOut, child.run.slug, 1000);
  });
  await t.test('mindmap validates authored fixture and renders materialized placement with motion and matching seam', async () => {
    const fixture = json(path.join(ROOT, 'test/fixtures/agent-mock-mindmap.json'));
    const validation = validateScene(fixture); assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    const maps = path.join(root, 'mindmap');
    await cli(['mindmap', 'agentic AI', '--brain', 'mock', '--out', maps]);
    const { dir, scene } = delivery(maps, 'agentic-ai', 1100);
    assert.equal(scene.layout.kind, 'mindmap'); assert.ok(scene.layout.mindmap.placement);
    const proposal = json(path.join(dir, 'steps/03-scene-a1.json')).proposal.scene;
    assert.deepEqual(proposal.nodes, []); assert.deepEqual(proposal.edges, []); assert.deepEqual(proposal.timeline.animations, []);
    assert.equal(proposal.layout.mindmap.placement, undefined);
    assert.doesNotMatch(JSON.stringify(proposal.layout.mindmap), /"(?:x|y|w|h|cx|cy)":/);
  });
});

test('recorded HN and GitHub responses produce a stable table with exact scorer values', async t => {
  const { normalizeCandidate } = require('../src/agent/research');
  const candidates = [];
  for (const provider of ['hn', 'github']) {
    const recorded = require('./fixtures/research/' + provider + '-recorded.json');
    const values = await require('../src/agent/research/' + provider).search('RAG', {
      fetch: async () => new Response(JSON.stringify(recorded.body), { status: recorded.status })
    });
    candidates.push(normalizeCandidate(values[0]));
  }
  const now = Date.parse('2026-09-05T12:00:00Z');
  const ranked = rankCandidates(candidates, now);
  assert.deepEqual(ranked.map(c => [c.provider, c.virality]), [['hn', 29], ['github', 18]]);
  assert.deepEqual(ranked, rankCandidates([...candidates].reverse(), now));
  const table = ['rank | heuristic virality | title | source', ...ranked.map((c, i) => [i + 1, c.virality, c.title, c.provider].join(' | '))].join('\n');
  t.diagnostic(table);
});

test('opt-in authenticated codex smoke accepts structured evidence or typed auth/quota failure', {
  skip: process.env.DIAGIF_REAL_BRAIN !== '1', timeout: 900000
}, async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-real-brain-'));
  const env = { ...process.env }; delete env.DIAGIF_OFFLINE;
  const args = ['make', 'explain RAG', '--brain', 'codex-cli', '--research', 'mock', '--dry-run', '--max-model-calls', '6', '--out', out];
  const result = await execute(process.execPath, [path.join(ROOT, 'bin/diagif.js'), ...args], { cwd: out, env, timeout: 840000 });
  t.diagnostic(JSON.stringify({ args, ...result, out }));
  const run = json(path.join(out, 'explain-rag/run.json'));
  validateValue(require('../src/agent/schemas/run.schema.json'), run);
  if (result.code === 0) {
    for (const name of ['01-research', '02-brief']) assert.ok(run.steps.some(s => s.name === name && s.status === 'success'));
    assert.ok(run.modelCalls.length > 0 && run.modelCalls.every(c => c.structured && c.schemaValid));
  } else {
    assert.equal(result.code, 3, result.stderr);
    assert.ok(['PROVIDER_QUOTA', 'PROVIDER_AUTH'].includes(run.error.code), JSON.stringify(run.error));
  }
});
