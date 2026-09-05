'use strict';
const { AgentResearchInsufficient, toSafeJson } = require('../errors');
const { hash, assertOnline, deadline, bounded } = require('./common');
const { canonicalUrl, ResearchCache, safeRecord } = require('./cache');
const { norm, grounding, extractText } = require('./extract');
const { getMockResearch } = require('./mock');
const page = require('./page');
const ADAPTERS = {
  hn: require('./hn').search, github: require('./github').search, reddit: require('./reddit').search,
  duckduckgo: require('./duckduckgo').search, page: page.search,
  exa: require('./keyed').exa, tavily: require('./keyed').tavily, brave: require('./keyed').brave
};
const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
function normalizeCandidate(item, provider = item.provider) {
  if (!Object.hasOwn(ADAPTERS, provider)) throw new TypeError('Unknown research provider.');
  const url = canonicalUrl(item.url);
  const title = extractText(item.title || '').replace(/\s+/g, ' ').slice(0, 300).trim();
  if (!title) throw new TypeError('Research source has no title.');
  const timestamp = item.publishedAt == null ? NaN : Date.parse(item.publishedAt);
  return { id: `src-${hash(url).slice(0, 20)}`, url, title, provider,
    publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    engagement: { score: nonnegative(item.engagement?.score), comments: nonnegative(item.engagement?.comments) },
    excerpt: extractText(item.excerpt || '').slice(0, 2000) };
}
function sourceOnly({ excerpt, ...source }) { return source; }
/** Collect evidence before invoking the research brain. Extracts are not claims. */
async function collectResearch(topic, options = {}) {
  const config = options.config || (typeof options.research === 'object' ? options : {});
  const mode = options.mode || options.researchMode || (typeof options.research === 'string' ? options.research : null) || 'live';
  if (mode === 'mock') return options.purpose === 'scout' || options.scout ? require('./mock').scout() : getMockResearch(topic);
  assertOnline();
  const providers = [...new Set(options.providers || config.research?.providers || ['hn', 'github', 'page'])];
  const scope = deadline(options.deadlineMs || config.limits?.researchDeadlineMs || 90000, options.signal);
  const now = options.now ?? Date.now;
  const retrievedAt = new Date(typeof now === 'function' ? now() : now).toISOString();
  const diagnostics = [], candidates = [], extracts = [];
  const cache = options.cache === false ? false : options.cache || new ResearchCache({ ...config.research, ...options });
  const context = { ...options, signal: scope.signal, cache,
    timeoutMs: options.timeoutMs || config.limits?.fetchTimeoutMs || 15000,
    allowHtmlSearch: options.allowHtmlSearch ?? config.research?.allowHtmlSearch ?? false,
    purpose: options.purpose || (options.scout ? 'scout' : 'research') };
  try {
    scope.signal.throwIfAborted();
    const results = await Promise.allSettled(providers.map(provider => bounded(Promise.resolve().then(() => {
      const adapter = options.adapters?.[provider] || ADAPTERS[provider];
      if (!adapter) throw new TypeError('Unknown research provider.');
      return adapter(topic, context);
    }), scope.signal)));
    const seen = new Set();
    for (let i = 0; i < results.length; i++) {
      const provider = providers[i], result = results[i];
      if (result.status === 'rejected') { diagnostics.push({ provider, error: toSafeJson(result.reason) }); continue; }
      if (result.value?.skipped) { diagnostics.push({ provider, skipped: result.value.skipped }); continue; }
      const items = Array.isArray(result.value) ? result.value : result.value?.candidates;
      if (!Array.isArray(items)) { diagnostics.push({ provider, error: { code: 'PROVIDER', message: 'Adapter returned no candidate array.' } }); continue; }
      for (const item of items) {
        try {
          const candidate = normalizeCandidate(item, provider);
          if (!seen.has(candidate.url) && candidates.length < 30) { seen.add(candidate.url); candidates.push(candidate); }
        } catch { diagnostics.push({ provider, skipped: 'invalid-candidate' }); }
      }
    }
    if (options.extract !== false) {
      const pages = await Promise.allSettled(candidates.map(candidate => bounded(page.fetchExtract(sourceOnly(candidate), context), scope.signal)));
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].status === 'fulfilled') extracts.push(pages[i].value);
        else diagnostics.push({ provider: candidates[i].provider, sourceId: candidates[i].id, error: toSafeJson(pages[i].reason) });
      }
    }
    return safeRecord({ topic, retrievedAt, candidates, sources: candidates.map(sourceOnly), extracts, diagnostics });
  } finally { scope.close(); }
}
function extractFor(source, extracts) {
  if (Array.isArray(extracts)) return extracts.find(item => item.sourceId === source.id && canonicalUrl(item.url || item.finalUrl) === canonicalUrl(source.url));
  const value = extracts instanceof Map ? extracts.get(source.id) ?? extracts.get(source.url) : extracts?.[source.id] ?? extracts?.[source.url];
  return typeof value === 'string' ? { text: value } : value;
}
/** Post-validation returns facts enriched with evidence offsets/hashes. */
function validateFactSheet(sheet, extracts) {
  const fail = message => { throw new AgentResearchInsufficient(message); };
  if (!Array.isArray(sheet?.sources) || sheet.sources.length < 1 || sheet.sources.length > 30 || !Array.isArray(sheet.facts) || sheet.facts.length < 6 || sheet.facts.length > 12) fail('Research requires 6–12 grounded facts and 1–30 sources.');
  const sources = new Map(sheet.sources.map(source => [source.id, source]));
  if (sources.size !== sheet.sources.length) fail('Research source IDs must be unique.');
  const statements = new Set(), ids = new Set();
  const facts = sheet.facts.map((fact, index) => {
    if (typeof fact.statement !== 'string' || typeof fact.quote !== 'string' || !/^fact-[a-z0-9-]{1,80}$/.test(fact.id)) fail('Malformed research fact.');
    const statement = norm(fact.statement);
    if (!statement || statements.has(statement) || ids.has(fact.id)) fail('Research fact IDs and normalized statements must be unique.');
    statements.add(statement); ids.add(fact.id);
    const source = sources.get(fact.sourceId);
    if (!source) fail('Research fact refers to an unknown source.');
    let extract;
    try { extract = extractFor(source, extracts); } catch { fail('Research source URL does not match its fetched extract.'); }
    if (typeof extract?.text !== 'string') fail('Research fact has no fetched extract for its cited URL.');
    if (extract.contentHash && extract.contentHash !== hash(extract.text)) fail('Research extract hash does not match its text.');
    const evidence = grounding(fact.quote, extract.text);
    if (!evidence) throw new AgentResearchInsufficient('Research quote is not grounded in its cited extract.', {
      details: [{ path: '/facts/' + index + '/quote', message: 'Copy the exact quote from its cited extract, including whitespace before punctuation.',
        factId: fact.id, sourceId: fact.sourceId, quote: fact.quote }]
    });
    return { ...fact, ...evidence };
  });
  return { ...sheet, facts };
}
// Projection for consumers that need the minimal proposal shape in the locked plan.
function factSheetForSchema(sheet) {
  return { topic: sheet.topic, retrievedAt: sheet.retrievedAt,
    sources: sheet.sources.map(source => Object.fromEntries(['id', 'url', 'title', 'provider', 'publishedAt', 'engagement'].map(key => [key, source[key]]))),
    facts: sheet.facts.map(({ id, statement, sourceId, quote }) => ({ id, statement, sourceId, quote })) };
}
// Harness ports: preserve the original source schema separately from collection
// metadata, and attach evidence only after every fact passes the post-condition.
function selectResearch(mode = 'live', config = {}) {
  if (!['live', 'mock'].includes(mode)) throw new TypeError('Research mode must be live or mock.');
  return { name: mode, mode, async collect(topic, options = {}) {
    const result = await collectResearch(topic, { ...options, config: { ...config, ...options }, mode });
    const hashes = new Map(result.extracts.map(extract => [extract.sourceId, extract.contentHash]));
    return { ...result, sources: result.sources.map(source => ({ ...source, contentHash: hashes.get(source.id) || hash('') })) };
  } };
}
function assertGrounded(sheet, collected) {
  const grounded = validateFactSheet(sheet, collected?.extracts || collected);
  sheet.facts = grounded.facts;
  return sheet;
}
module.exports = { collectResearch, research: collectResearch, collect: collectResearch, selectResearch, assertGrounded, normalizeCandidate, canonicalUrl, validateFactSheet, groundFactSheet: validateFactSheet, factSheetForSchema, getMockResearch };
