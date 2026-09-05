'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreCandidate, rankCandidates } = require('../src/agent/virality');
const now = Date.UTC(2026, 8, 5);
const base = { title: 'Practical database query performance', publishedAt: new Date(now).toISOString(), provider: 'page', engagement: { score: 0, comments: 0 } };
for (const [title, score] of [['Redis vs. Postgres architecture', 50], ['How database indexing works', 46], ['Why database caching fails', 46], ['5-steps for database indexing', 44], ['Fix slow database queries', 40], ['Practical database query performance', 22], ['guide', 10]]) {
  test('format branch: ' + title, () => assert.equal(scoreCandidate({ ...base, title }, now), score));
}
for (const [days, points] of [[-1, 20], [1, 20], [1.001, 16], [7, 16], [7.001, 10], [30, 10], [30.001, 4], [90, 4], [90.001, 0]]) {
  test('recency boundary ' + days, () => assert.equal(scoreCandidate({ ...base, publishedAt: new Date(now - days * 86400000).toISOString() }, now), points + 2));
}
test('unknown date uses 30 days; sources have fixed bonuses', () => {
  for (const [provider, bonus] of [['hn', 7], ['reddit', 7], ['github', 5], ['page', 2], ['brave', 0]]) assert.equal(scoreCandidate({ ...base, provider, publishedAt: null }, now), 10 + bonus);
});
test('engagement follows logarithmic formula, caps at 25 and is monotonic', () => {
  let previous = 0;
  for (const score of [-10, 0, 1, 10, 100, 10000, 1e20]) {
    const value = scoreCandidate({ ...base, engagement: { score, comments: 10 } }, now);
    assert.equal(value, 22 + Math.min(25, Math.round(6 * Math.log10(1 + Math.max(0, score)) + 4 * Math.log10(11))));
    assert.ok(value >= previous); previous = value;
  }
});
test('ranking recomputes scores, breaks ties in English and never mutates inputs', () => {
  const values = [{ ...base, title: 'Zebra database query performance', virality: 100 }, { ...base, title: 'Alpha database query performance', virality: 0 }];
  assert.deepEqual(rankCandidates(values, now).map(item => item.title), ['Alpha database query performance', 'Zebra database query performance']);
  assert.equal(values[0].virality, 100); assert.deepEqual(rankCandidates(values, now), rankCandidates(values, now));
});
