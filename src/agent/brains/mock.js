'use strict';

const { AgentUsageError, AgentResearchInsufficient } = require('../errors');
const sheets = require('../fixtures/mock-fact-sheets.json');
const cannedBrief = require('../fixtures/brief.json');
const cannedScene = require('../fixtures/scene.json');
const cannedMindmap = require('../fixtures/mindmap.json');
const SCRIPTS = ['happy', 'schema-retry', 'critic-repair', 'scene-exhaust', 'budget'];

function contextOf(request) {
  const objects = [];
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    objects.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') collect(child);
  }
  collect(request.context); collect(request.factSheet); collect(request.brief);
  for (const message of request.messages || []) {
    if (typeof message.content === 'object') collect(message.content);
    else { try { collect(JSON.parse(message.content)); } catch {
      try { collect(require('./index').extractJson(message.content)); } catch {}
    } }
  }
  const prompt = [request.system || '', ...((request.messages || []).map(item => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)))].join('\n');
  const topic = request.topic || objects.find(item => typeof item.topic === 'string')?.topic || Object.keys(sheets).find(key => prompt.toLowerCase().includes(key.toLowerCase())) || 'explain RAG';
  return { objects, prompt, topic, forcedFormat: request.forcedFormat || objects.find(item => item.forcedFormat === 'mindmap')?.forcedFormat,
    factSheet: objects.find(item => Array.isArray(item.facts) && Array.isArray(item.sources)), brief: objects.find(item => item.post && item.factIds && item.format) };
}
function proposalClaims(scene) {
  const claims = [{ path: '/title/text', text: scene.title.text, supports: ['authoring'] }];
  for (const [i, node] of scene.nodes.entries()) claims.push({ path: `/nodes/${i}/label`, text: node.label, supports: ['authoring'] });
  if (scene.layout.kind === 'mindmap') {
    const tree = scene.layout.mindmap;
    claims.push({ path: '/layout/mindmap/root/label', text: tree.root.label, supports: ['authoring'] });
    tree.branches.forEach((branch, i) => {
      claims.push({ path: `/layout/mindmap/branches/${i}/label`, text: branch.label, supports: ['authoring'] });
      branch.leaves.forEach((leaf, j) => claims.push({ path: `/layout/mindmap/branches/${i}/leaves/${j}/label`, text: leaf.label, supports: ['authoring'] }));
    });
  }
  return claims;
}
function createMockBrain(script = 'happy') {
  if (!SCRIPTS.includes(script)) throw new AgentUsageError('Unknown mock script: ' + script);
  const calls = new Map();
  return { name: 'mock', provider: 'mock', model: 'mock', script, capability: { vision: false }, async complete(request) {
    const key = request.schema?.$id?.split(':').at(-1);
    if (!['fact-sheet', 'brief', 'scene-proposal', 'critic-verdict', 'scout-result'].includes(key)) throw new AgentUsageError('Mock brain requires a known original schema $id');
    const attempt = (calls.get(key) || 0) + 1;
    calls.set(key, attempt);
    const context = contextOf(request);
    let value;
    if (key === 'fact-sheet') {
      value = structuredClone(context.factSheet || sheets[context.topic] || sheets['explain RAG']);
      value.topic = context.topic;
      // When the research job supplies extracts, quote those exact recorded texts.
      const extracts = context.objects.filter(item => typeof item.id === 'string' && item.id.startsWith('src-') && item.url).map(source => {
        const extract = context.objects.find(item => item.sourceId === source.id && typeof item.text === 'string');
        return { ...source, text: extract?.text || source.text || source.excerpt };
      }).filter(source => source.text);
      if (extracts.length) {
        const facts = [];
        for (const source of extracts) for (const quote of (source.text || source.excerpt).split(/(?<=[.!?])\s+|\n+/).map(text => text.trim()).filter(text => text.length >= 12 && text.split(/\s+/).length >= 4)) {
          if (facts.some(fact => fact.quote === quote)) continue;
          facts.push({ id: 'fact-' + (facts.length + 1), statement: quote.slice(0, 300), sourceId: source.id, quote: quote.slice(0, 600) });
        }
        if (facts.length >= 6) {
          value.facts = facts.slice(0, 12);
          value.sources = extracts.filter((source, i) => extracts.findIndex(item => item.id === source.id) === i).map(source => ({ id: source.id, url: source.url, title: source.title, provider: source.provider, publishedAt: source.publishedAt ?? null, engagement: source.engagement || { score: 0, comments: 0 } }));
        } else throw new AgentResearchInsufficient('Mock research requires at least six sentences in supplied extracts');
      }
    } else if (key === 'brief') {
      value = structuredClone(cannedBrief); value.topic = context.topic;
      if (context.factSheet) value.factIds = context.factSheet.facts.slice(0, 3).map(fact => fact.id);
      if (/agentic/i.test(context.topic)) {
        value.hook = 'Agentic AI: a controlled loop'; value.post.hook = value.hook;
        value.angle = 'Show planning, actions, observations and evaluation in an agent loop.';
        value.post.lines = (context.factSheet || sheets['agentic AI']).facts.slice(0, 3).map(fact => fact.statement);
        value.post.cta = 'Which control would you add to your agent loop?'; value.post.hashtags = ['#AgenticAI', '#AIEngineering'];
      }
      if (/REST API/i.test(context.topic)) {
        value.hook = 'Make each API request do less work'; value.post.hook = value.hook; value.format = 'steps';
        value.angle = 'Reduce repeated work, payload size and database lookup costs.';
        value.post.lines = (context.factSheet || sheets['REST API optimisation techniques']).facts.slice(0, 3).map(fact => fact.statement);
        value.post.cta = 'Which API bottleneck would you measure first?'; value.post.hashtags = ['#REST', '#APIDesign'];
      }
      if (request.format === 'mindmap' || context.forcedFormat === 'mindmap') value.format = 'mindmap';
    } else if (key === 'scene-proposal') {
      const mindmap = request.format === 'mindmap' || context.forcedFormat === 'mindmap' || context.brief?.format === 'mindmap';
      const scene = structuredClone(mindmap ? cannedMindmap : cannedScene);
      if (context.brief?.hook) scene.title.text = context.brief.hook;
      if (!mindmap && /REST API/i.test(context.topic)) {
        const labels = ['Bound the response', 'Reuse cached data', 'Compress the payload', 'Index lookup fields', 'Reuse connections'];
        scene.nodes.forEach((node, i) => { node.label = labels[i]; });
      }
      if (script === 'scene-exhaust' && !mindmap) {
        scene.title.text = 'This fixture title must remain explicitly grounded';
        for (const node of scene.nodes) { node.x = 240; node.y = 320; }
      }
      value = { scene, claims: proposalClaims(scene), authoringNotes: ['Deterministic offline fixture; diagram labels are authoring choices.'] };
      if (script === 'scene-exhaust' && !mindmap) value.claims = value.claims.filter(claim => claim.path !== '/title/text');
      if (script === 'scene-exhaust' && mindmap) value.claims.pop();
    } else if (key === 'critic-verdict') {
      const repair = script === 'critic-repair' && attempt === 1;
      value = { mode: 'heuristic', verdict: repair ? 'repair' : 'pass', checks: { readability: 'unmeasured', overlap: repair ? 'fail' : 'pass', seam: 'pass', motion: 'pass', hook: 'unmeasured', brand: 'pass' },
        edits: repair ? [{ target: '/title/text', instruction: 'Keep the hook concise and readable.', severity: 'must' }] : [] };
    } else {
      value = { domain: context.topic, generatedAt: '2026-09-05T00:00:00Z', candidates: Object.entries(sheets).map(([topic, sheet]) => ({ topic, title: topic, rationale: 'Explain a practical technical concept with a short diagram.', sourceIds: sheet.sources.map(source => source.id), signals: { recency: 30, score: 0, comments: 0 }, virality: 0 })) };
    }
    if (script === 'schema-retry' && [...calls.values()].reduce((a, b) => a + b, 0) === 1) value = {};
    return { value, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'none' }, provider: 'mock', model: 'mock', capability: { vision: false }, wire: { dialect: 'none', strict: false, structured: true }, stopReason: 'completed' };
  } };
}
module.exports = { createMockBrain, SCRIPTS, mockFactSheets: sheets, proposalClaims };
