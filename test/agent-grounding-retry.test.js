'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrainRunner } = require('../src/agent/brains');
const { validateFactSheet } = require('../src/agent/research');
const { AgentResearchInsufficient } = require('../src/agent/errors');
const schema = require('../src/agent/schemas/fact-sheet.schema.json');

function fixture() {
  const source = { id: 'src-example', url: 'https://example.org/idempotency', title: 'Idempotency example', provider: 'page', publishedAt: null, engagement: { score: 0, comments: 0 } };
  const facts = Array.from({ length: 6 }, (_, i) => ({ id: 'fact-' + i, statement: 'Distinct grounded statement number ' + i,
    sourceId: source.id, quote: 'The request number ' + i + ' gets a 422 , never a silent execution.' }));
  const sheet = { topic: 'REST API idempotency keys', retrievedAt: '2026-09-05T00:00:00Z', sources: [source], facts };
  const extracts = [{ sourceId: source.id, url: source.url, text: facts.map(f => f.quote).join('\n') }];
  return { sheet, extracts };
}

test('a quote whitespace failure is corrected against the same extract within durable model-call accounting', async () => {
  const { sheet, extracts } = fixture(), bad = structuredClone(sheet); bad.facts[0].quote = bad.facts[0].quote.replace('422 ,', '422,');
  assert.throws(() => validateFactSheet(bad, extracts), error => error.code === 'RESEARCH_INSUFFICIENT' && error.details[0].path === '/facts/0/quote');
  const run = { budget: { modelCallsUsed: 0, maxModelCalls: 3 }, modelCalls: [] }, requests = [], saves = [];
  const runner = createBrainRunner({ provider: 'mock', model: 'fixture', complete: async request => {
    assert.equal(saves.at(-1), requests.length + 1); requests.push(request);
    return { value: structuredClone(requests.length === 1 ? bad : sheet) };
  } }, { run, persist: async () => { saves.push(run.budget.modelCallsUsed); }, env: {} });
  const result = await runner.complete({ step: 'research', schema, messages: [{ role: 'user', content: JSON.stringify({ sources: sheet.sources, extracts }) }], postValidate: value => validateFactSheet(value, extracts) });
  assert.deepEqual(result.value, sheet); assert.equal(run.budget.modelCallsUsed, 2);
  assert.deepEqual(run.modelCalls.map(c => c.schemaValid), [false, true]);
  assert.match(requests[1].messages.at(-1).content, /previousFactSheet/);
  assert.match(requests[1].messages.at(-1).content, /spaces before punctuation/);
  assert.equal(validateFactSheet(result.value, extracts).facts.length, 6);
});

test('permanently ungrounded output fails after three corrections, while insufficient provider evidence is not retried', async () => {
  const { sheet, extracts } = fixture(); sheet.facts[0].quote = 'This sentence never appeared in the fetched evidence.';
  let calls = 0;
  const run = { budget: { modelCallsUsed: 0, maxModelCalls: 28 }, modelCalls: [] };
  const runner = createBrainRunner({ provider: 'mock', model: 'fixture', complete: async () => { calls++; return { value: sheet }; } }, { run, persist: async () => {}, env: {} });
  await assert.rejects(runner.complete({ step: 'research', schema, postValidate: value => validateFactSheet(value, extracts) }), { code: 'RESEARCH_INSUFFICIENT' });
  assert.equal(calls, 3); assert.equal(run.budget.modelCallsUsed, 3);
  calls = 0;
  const unavailable = createBrainRunner({ provider: 'mock', model: 'fixture', complete: async () => { calls++; throw new AgentResearchInsufficient('No fetched source text'); } }, { run, persist: async () => {}, env: {} });
  await assert.rejects(unavailable.complete({ step: 'research', schema, postValidate: () => {} }), { code: 'RESEARCH_INSUFFICIENT' });
  assert.equal(calls, 1);
});
