'use strict';
const { hash } = require('./common');
const { AgentResearchInsufficient } = require('../errors');
// Synthetic offline evidence, deliberately identified as packaged fixtures rather
// than live research. Keeping it outside test/ makes installed mock runs work.
const { retrievedAt: RETRIEVED_AT, pages: TOPICS } = require('../fixtures/research-mock-pages.json');
function getMockResearch(topic) {
  const key = Object.keys(TOPICS).find(key => key.toLowerCase() === String(topic).trim().toLowerCase());
  if (!key) throw new AgentResearchInsufficient('Mock research supports exactly: explain RAG; REST API optimisation techniques; agentic AI.');
  // Keep fixture identity aligned with Job A's canned fact sheets and scout IDs.
  const index = Object.keys(TOPICS).indexOf(key);
  const url = `https://example.com/mock/${['rag', 'rest', 'agentic'][index]}`;
  const source = { id: `src-mock-${index}-guide`, url, title: `${key} reference`, provider: 'page', publishedAt: null, engagement: { score: 0, comments: 0 } };
  const text = TOPICS[key].join('\n');
  const facts = TOPICS[key].map((quote, index) => ({ id: `fact-${index + 1}`, statement: quote, sourceId: source.id, quote }));
  return {
    topic: key, retrievedAt: RETRIEVED_AT, candidates: [{ ...source, excerpt: text }], sources: [source],
    extracts: [{ sourceId: source.id, url, finalUrl: url, text, contentHash: hash(text), cached: false }],
    diagnostics: [], factSheet: { topic: key, retrievedAt: RETRIEVED_AT, sources: [structuredClone(source)], facts }
  };
}
function scout() {
  const items = Object.keys(TOPICS).map(getMockResearch);
  return { retrievedAt: RETRIEVED_AT, candidates: items.flatMap(item => item.candidates), sources: items.flatMap(item => item.sources), extracts: items.flatMap(item => item.extracts), diagnostics: [] };
}
module.exports = { getMockResearch, research: getMockResearch, collect: getMockResearch, scout, TOPICS: Object.freeze(Object.keys(TOPICS)) };
