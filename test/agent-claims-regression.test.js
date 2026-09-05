'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { claimsCover, collectDiagramText, carryClaims, classifySlot } = require('../src/agent/claims');
const { deterministicRepair } = require('../src/agent/scene-repair');
const { validateScene } = require('../src/schema');
const { validateValue } = require('../src/agent/brains/schema');
const facts = require('./fixtures/agent-real-proposals/fact-sheet.json');

for (const [attempt, slotCount, claimCount] of [[1, 25, 25], [2, 24, 24], [3, 28, 30], [4, 10, 10]]) {
  test('captured real proposal a' + attempt + ' resolves and repairs without another model call', () => {
    const proposal = structuredClone(require('./fixtures/agent-real-proposals/a' + attempt + '.json'));
    const coverage = claimsCover(proposal.scene, proposal.claims, facts);
    assert.equal(coverage.slots.length, slotCount); assert.equal(proposal.claims.length, claimCount);
    assert.deepEqual(coverage.errors, []);
    if (attempt === 2) {
      assert.equal(coverage.claims.filter(claim => claim.resolvedBy === 'path').length, 24);
      assert.equal(coverage.warnings.filter(w => w.code === 'claim-text-paraphrased').length, 24);
    }
    if (attempt === 3) assert.ok(coverage.warnings.some(w => w.code === 'redundant-title-line-claim' && w.text === 'RAG: Search, Then'));
    const before = structuredClone(proposal.scene), trace = deterministicRepair(proposal.scene);
    const carried = carryClaims(proposal.scene, coverage.claims, trace, before);
    assert.deepEqual(claimsCover(proposal.scene, carried, facts).errors, []);
    const validation = validateScene(proposal.scene);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors));
    assert.ok(trace.penalties.length <= 3);
  });
}

test('normalized text covers repeated labels with unioned supports despite bad advisory paths', () => {
  const scene = { title: { text: '“Agent”—works…' }, nodes: [{ id: 'a', label: 'Retrieve documents' }, { id: 'b', label: 'Retrieve documents' }] };
  const result = claimsCover(scene, [
    { text: '"Ａgent"-works...\u200b', supports: ['authoring'] },
    { path: '/wrong', text: ' retrieve   DOCUMENTS ', supports: ['fact-one'] },
    { path: '/nodes/b/label', text: 'Retrieve documents', supports: ['fact-two'] }
  ], { facts: [{ id: 'fact-one' }, { id: 'fact-two' }] });
  assert.deepEqual(result.errors, []);
  for (const slot of result.slots.filter(s => s.path.startsWith('/nodes'))) assert.deepEqual(slot.supports, ['fact-one', 'fact-two']);
  assert.equal(result.warnings.filter(w => w.code === 'claim-path-advisory').length, 1);
});

test('normalized id paths and scene prefixes resolve paraphrases for nodes and edges', () => {
  const scene = { nodes: [{ id: 'source-docs', label: 'Source docs' }], edges: [{ id: 'add-context', label: { text: 'add context' } }] };
  const result = claimsCover(scene, [
    { path: '/scene/nodes/source-docs/label', text: 'Documents enter here.', supports: ['authoring'] },
    { path: '/scene/edges/add-context/label/text', text: 'Put the context in.', supports: ['authoring'] }
  ], { facts: [] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.claims.map(c => [c.path, c.text, c.resolvedBy]), [['/nodes/0/label', 'Source docs', 'path'], ['/edges/0/label/text', 'add context', 'path']]);
});

test('unsupported fact IDs, empty supports, unmatched claims and uncovered substantive text still fail', () => {
  const scene = { title: { text: 'Title', subtitle: { text: 'Thesis' } }, nodes: [{ label: 'Retrieve' }] };
  const result = claimsCover(scene, [
    { text: 'Title', supports: ['fact-invented'] }, { text: 'Retrieve', supports: [] },
    { path: '/missing', text: 'Not drawn anywhere', supports: ['authoring'] }
  ], { facts: [] });
  assert.equal(result.ok, false);
  for (const message of ['Unknown supporting fact: fact-invented', 'Claim requires support', 'Claim matches no diagram text or path: "Not drawn anywhere"', 'Substantive diagram text has no matching claim: "Thesis"']) {
    assert.ok(result.errors.some(e => e.message === message), message);
  }
  assert.deepEqual(result.uncoveredSubstantiveTexts, ['Thesis']);
});

test('graded connective guard strips ordinals, escalates numeric/comparative claims, warns on scope markers', () => {
  const texts = ['chunk + embed', 'retry until pass', '10k requests', 'GraphRAG costs 8x more', 'faster than vector search', '1. Write the state', '2. Consumers', 'orders only', 'switch all', 'BEFORE / BRANCH ON EVERY TYPE', 'more than one'];
  const scene = { edges: texts.map(text => ({ label: { text } })) };
  const result = claimsCover(scene, [], { facts: [] });
  assert.deepEqual(result.escalatedSlots.map(s => s.text), ['10k requests', 'GraphRAG costs 8x more', 'faster than vector search', 'more than one']);
  assert.deepEqual(result.warnings.filter(w => w.code === 'connective-marker').map(w => w.text), ['orders only', 'switch all', 'BEFORE / BRANCH ON EVERY TYPE']);
  assert.equal(result.autoAuthoringSlots.length, 7);
  assert.ok(result.autoAuthoringSlots.every(s => s.supports[0] === 'authoring'));
});

test('existing scene corpus escalates exactly its six numeric edge labels and never treats a subtitle as connective', () => {
  const directory = path.join(__dirname, '../scenes'), escalated = [], ordinals = new Set();
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.json'))) {
    const slots = collectDiagramText(JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')));
    for (const slot of slots) {
      const kind = classifySlot(slot);
      if (slot.path === '/title/subtitle/text') assert.equal(kind, 'substantive');
      if (kind === 'escalated') { assert.match(slot.path, /^\/edges\//); escalated.push(slot.text); }
      if (['1. Write the state', '2. Consumers'].includes(slot.text)) { assert.equal(kind, 'connective'); ordinals.add(slot.text); }
    }
  }
  assert.deepEqual(escalated.sort(), ['5% sample', '10k reads', '1 read', 'authorize + S256', 'skip 2', 'take 2'].sort());
  assert.equal(ordinals.size, 2);
});

test('title wrapping cannot hide different rendered text behind a claimed title', () => {
  const scene = { title: { text: 'Known title', lines: ['Unproved claim'] } };
  const result = claimsCover(scene, [{ text: 'Known title', supports: ['authoring'] }], { facts: [] });
  assert.deepEqual(result.uncoveredSubstantiveTexts, ['Unproved claim']);
  const stray = claimsCover({ title: { text: 'Known title' } }, [{ path: '/title/lines/0', text: 'Invisible fragment', supports: ['authoring'] }], { facts: [] });
  assert.ok(stray.errors.some(e => e.message.startsWith('Claim matches no diagram text or path:')));
});

test('claim carry follows repaired slot identity, splits repeats, and refuses major meaning loss or unrecorded rewrites', () => {
  const before = { nodes: [{ id: 'a', label: 'Retrieve all relevant source documents today' }, { id: 'b', label: 'Retrieve all relevant source documents today' }] };
  const claim = { text: before.nodes[0].label, supports: ['authoring'] };
  const scene = structuredClone(before); scene.nodes[0].label = 'Retrieve all relevant source';
  const trace = [{ path: '/nodes/0/label', old: before.nodes[0].label, new: scene.nodes[0].label, rule: 'label-overflow' }];
  const carried = carryClaims(scene, [claim], trace, before);
  assert.deepEqual(claimsCover(scene, carried, { facts: [] }).errors, []);
  assert.equal(trace[0].claimCarried, true);
  assert.deepEqual(carried.map(c => c.text), [scene.nodes[0].label, before.nodes[1].label]);
  scene.nodes[0].label = 'Retrieve'; trace[0].new = 'Retrieve'; delete trace[0].claimCarried;
  assert.deepEqual(claimsCover(scene, carryClaims(scene, [claim], trace, before), { facts: [] }).uncoveredSubstantiveTexts, ['Retrieve']);
  assert.deepEqual(claimsCover(scene, carryClaims(scene, [claim], trace), { facts: [] }).uncoveredSubstantiveTexts, ['Retrieve']);
  assert.equal(trace[0].claimCarried, undefined);
  assert.deepEqual(claimsCover(scene, carryClaims(scene, [claim], [], before), { facts: [] }).uncoveredSubstantiveTexts, ['Retrieve']);
});

test('only claims for recorded deleted properties are dropped', () => {
  const before = { title: { text: 'Title', invented: 'Ghost' } }, scene = { title: { text: 'Title' } };
  const claims = [{ path: '/title/invented', text: 'Ghost', supports: ['authoring'] }, { text: 'Title', supports: ['authoring'] }];
  const trace = [{ path: '/title/invented', old: 'Ghost', new: null, rule: 'unknown-property' }];
  assert.equal(carryClaims(scene, claims, trace, before).length, 1); assert.equal(trace[0].claimDropped, true);
  assert.equal(carryClaims(scene, claims, [], before).length, 2);
});

test('deleting an advisory path never drops support for a different live text-resolved slot', () => {
  const before = { title: { text: 'Title', invented: 'Retrieve' }, nodes: [{ id: 'n', label: 'Retrieve' }] };
  const claims = [{ text: 'Title', supports: ['authoring'] }, { path: '/title/invented', text: 'Retrieve', supports: ['authoring'] }];
  const scene = structuredClone(before); delete scene.title.invented;
  const trace = [{ path: '/title/invented', old: 'Retrieve', new: null, rule: 'unknown-property' }];
  const carried = carryClaims(scene, claimsCover(before, claims, { facts: [] }).claims, trace, before);
  assert.deepEqual(claimsCover(scene, carried, { facts: [] }).errors, []);
  assert.equal(trace[0].claimDropped, undefined);
});

test('proposal schema permits pathless claims and arbitrary advisory path strings but still requires support', () => {
  const proposal = structuredClone(require('./fixtures/agent-real-proposals/a4.json'));
  proposal.claims.forEach(claim => { delete claim.path; });
  const schema = require('../src/agent/schemas/scene-proposal.schema.json');
  assert.doesNotThrow(() => validateValue(schema, proposal));
  proposal.claims[0].path = 'not a pointer'; assert.doesNotThrow(() => validateValue(schema, proposal));
  proposal.claims[0].supports = []; assert.throws(() => validateValue(schema, proposal), /schema/);
});
