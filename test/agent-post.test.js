'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listItemCount, consistentPost } = require('../src/agent/post.js');
const { postMarkdown } = require('../src/agent/harness.js');
const post = (cta = 'Trace these six stages.') => ({ hook: 'RAG explained', lines: ['1. Retrieve.', '2. Rank.', '3. Augment.', '4. Generate.'], cta, hashtags: ['#RAG'] });

for (const value of ['six', '6', '**six**', 'SIX', 'twenty-one', 'one hundred and two', '1,000']) {
  test('caption count is computed from its list: ' + value, () => {
    const p = post('Trace these ' + value + ' stages.');
    assert.match(postMarkdown(p), /Trace these (?:\*\*)?4(?:\*\*)? stages\./);
    assert.equal(p.cta, 'Trace these ' + value + ' stages.', 'input stays unchanged');
  });
}
test('repairs hook, body summary and CTA, preserving factual quantities', () => {
  const p = post('Save these 12 key tips.'); p.hook = 'Six steps to RAG';
  p.lines.push('These five phases use 2 replicas, HTTP 429 and 50 ms.');
  const fixed = consistentPost(p);
  assert.equal(fixed.hook, '4 steps to RAG');
  assert.equal(fixed.cta, 'Save these 4 key tips.');
  assert.equal(fixed.lines.at(-1), 'These 4 phases use 2 replicas, HTTP 429 and 50 ms.');
  assert.deepEqual(consistentPost(fixed), fixed);
});
test('counts bullets, repeated ordered markers and multiline items by structure', () => {
  for (const marker of ['1.', '7)', '-', '*', '+', '•']) {
    assert.equal(listItemCount([marker + ' first', '  continuation', '  - nested', marker + ' second'].join('\r\n')), 2);
  }
});
test('fenced examples and nested bullets are not extra caption stages', () => {
  const p = post(); p.lines.splice(1, 0, '   - detail', '```md\n1. example\n```', '~~~\n- another example\n~~~');
  assert.match(postMarkdown(p), /Trace these 4 stages/);
});
test('caption without a list drops unsupported numerals', () => {
  const p = post(); p.lines = ['Retrieve passages.', 'Generate an answer.'];
  assert.equal(consistentPost(p).cta, 'Trace these stages.');
});
test('caption with a correct numeric count remains unchanged', () => {
  const p = post('Trace these 4 stages.'); assert.deepEqual(consistentPost(p), p);
});
