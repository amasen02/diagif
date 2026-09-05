'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { extractText, norm, isGrounded, loadParser } = require('../src/agent/research/extract');
const { collectResearch, validateFactSheet } = require('../src/agent/research');
const { getMockResearch } = require('../src/agent/research/mock');
const { ResearchCache, canonicalUrl } = require('../src/agent/research/cache');

test('extraction removes boilerplate and preserves inline spaces, entities and paragraphs', async () => {
  const html = await fs.readFile(path.join(__dirname, 'fixtures/research/article.html'), 'utf8');
  const expected = 'RAG & retrieval\nRetrieve relevant documents first.\nThen generate an answer.\nOne\nTwo';
  assert.equal(extractText(html, { parser: 'internal' }), expected);
  assert.equal(extractText(html), expected);
  assert.equal(extractText('<main>' + 'a'.repeat(41000) + '</main>').length, 40000);
  assert.equal(extractText('<p>A simple paragraph.</p>'), 'A simple paragraph.');
  assert.equal(extractText('<p>A\n simple\t paragraph.</p>'), 'A simple paragraph.');
  assert.equal(extractText('<main><div hidden="false"><article>Hidden article</article></div><p>Visible &#65; &#x42; &copy;</p></main>'), 'Visible A B ©');
});
test('the optional DOM extractor and internal fallback produce the same fixture text', async t => {
  const html = await fs.readFile(path.join(__dirname, 'fixtures/research/article.html'), 'utf8');
  const parser = loadParser();
  if (!parser) t.skip('linkedom is not installed in this working tree');
  else assert.equal(extractText(html), extractText(html, { parser: 'internal' }));
});
test('extractor falls back when loading linkedom throws', () => {
  const Module = require('node:module');
  const modulePath = require.resolve('../src/agent/research/extract');
  const cached = require.cache[modulePath];
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = (request, parent, isMain) => {
    if (request === 'linkedom') throw new Error('synthetic missing parser');
    return originalLoad(request, parent, isMain);
  };
  try {
    const fallback = require('../src/agent/research/extract');
    assert.equal(fallback.extractText('<main><p>Fallback extraction stays local.</p></main>'), 'Fallback extraction stays local.');
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
});
test('grounding is normalized exact containment, with length and token minimums', () => {
  assert.equal(norm('“Ａgent”—it\u200bs…\u00ad\u00a0OK'), '"agent"-its... ok');
  assert.equal(isGrounded('Retrieve relevant documents first.', 'We retrieve relevant documents first. Then answer.'), true);
  assert.equal(isGrounded('retrieve imaginary documents first', 'retrieve relevant documents first'), false);
  assert.equal(isGrounded('longwordonly', 'longwordonly'), false);
});
test('all three offline mock topics are deterministic and every fact is grounded', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw Error('network'); });
  t.mock.method(require('node:dns'), 'lookup', () => { throw Error('DNS'); });
  t.mock.method(require('node:child_process'), 'spawn', () => { throw Error('spawn'); });
  for (const topic of ['explain RAG', 'REST API optimisation techniques', 'agentic AI']) {
    const data = getMockResearch(topic);
    assert.deepEqual(await collectResearch(topic, { mode: 'mock' }), data);
    const grounded = validateFactSheet(data.factSheet, data.extracts);
    assert.equal(grounded.facts.length, 6);
    assert.ok(grounded.facts.every(f => f.quoteOffset >= 0 && /^[a-f0-9]{64}$/.test(f.extractHash)));
    assert.deepEqual(getMockResearch(topic), data);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.equal(require('node:dns').lookup.mock.callCount(), 0);
  assert.throws(() => getMockResearch('unknown topic'), { code: 'RESEARCH_INSUFFICIENT' });
});
test('fact sheet rejects invented sources, duplicate statements and ungrounded facts', () => {
  for (const mutation of [
    d => { d.factSheet.facts[0].sourceId = 'src-unknown'; },
    d => { d.factSheet.facts[0].statement = d.factSheet.facts[1].statement; },
    d => { d.factSheet.facts[0].quote = 'This quote does not exist anywhere.'; },
    d => { d.factSheet.facts.pop(); }
  ]) {
    const data = getMockResearch('explain RAG'); mutation(data);
    assert.throws(() => validateFactSheet(data.factSheet, data.extracts), { code: 'RESEARCH_INSUFFICIENT' });
  }
});
test('cache canonicalizes URLs, enforces TTL and fresh bypass, and verifies content hashes', async t => {
  const root = await fs.mkdtemp(path.join(__dirname, 'fixtures/research/cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = 1000000000;
  const cache = new ResearchCache({ cacheDir: root, now: () => now });
  const url = 'https://EXAMPLE.com:443/a#part';
  assert.equal(canonicalUrl(url), 'https://example.com/a');
  await cache.set(url, { finalUrl: url, text: 'Four words of evidence.', source: { title: 'Example' } });
  assert.equal((await cache.get(url)).text, 'Four words of evidence.');
  assert.equal(await cache.get(url, { fresh: true }), null);
  now += 6 * 3600000;
  assert.equal(await cache.get(url, { mode: 'scout' }), null);
  assert.ok(await cache.get(url));
  const file = cache.pathFor(url), entry = JSON.parse(await fs.readFile(file, 'utf8'));
  entry.text = 'tampered'; await fs.writeFile(file, JSON.stringify(entry));
  assert.equal(await cache.get(url), null);
  await cache.set(url, { text: 'Four words of evidence.', source: { title: 'Example' } });
  now += 7 * 86400000;
  assert.equal(await cache.get(url), null);
});

const fixture = name => require(`./fixtures/research/${name}`);
function jsonFetch(body, { status = 200, headers = {} } = {}, requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
}
test('recorded HN and GitHub provider responses preserve timestamps and engagement', async () => {
  const { normalizeCandidate } = require('../src/agent/research');
  for (const name of ['hn', 'github']) {
    const recorded = fixture(`${name}-recorded.json`), requests = [];
    const results = await require(`../src/agent/research/${name}`).search('RAG & vectors', {
      fetch: jsonFetch(recorded.body, recorded, requests)
    });
    assert.equal(recorded.status, 200);
    assert.ok(results.length > 0);
    const raw = name === 'hn' ? recorded.body.hits[0] : recorded.body.items[0];
    assert.equal(results[0].engagement.score, name === 'hn' ? raw.points : raw.stargazers_count);
    assert.equal(results[0].engagement.comments, name === 'hn' ? raw.num_comments : raw.open_issues_count);
    const candidate = normalizeCandidate(results[0]);
    assert.match(candidate.id, /^src-[a-z0-9-]{6,80}$/);
    assert.equal(candidate.publishedAt, new Date(raw.created_at).toISOString());
    assert.equal(new URL(requests[0].url).searchParams.get(name === 'hn' ? 'query' : 'q'), 'RAG & vectors');
    assert.match(requests[0].options.headers['User-Agent'], /^diagif\/0.1 /);
    assert.equal(requests[0].options.redirect, 'manual');
  }
});
test('GitHub quota responses are explicit skips; other failures stay failures', async () => {
  const { search } = require('../src/agent/research/github');
  for (const [status, body, headers] of [
    [403, { message: 'rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }],
    [403, { message: 'You have exceeded a secondary rate limit.' }, {}], [429, {}, {}]
  ]) assert.deepEqual(await search('topic', { fetch: jsonFetch(body, { status, headers }) }), { skipped: 'rate-limited' });
  await assert.rejects(search('topic', { fetch: jsonFetch({}, { status: 403 }) }), { code: 'PROVIDER' });
});
test('optional providers skip without opt-in or credentials and never call transport', async () => {
  const options = { env: {}, fetch: () => { throw Error('unexpected request'); }, fetchPage: () => { throw Error('unexpected page'); } };
  assert.deepEqual(await require('../src/agent/research/duckduckgo').search('topic', options), { skipped: 'html-search-disabled' });
  assert.deepEqual(await require('../src/agent/research/reddit').search('topic', options), { skipped: 'credentials-missing' });
  for (const provider of ['exa', 'tavily', 'brave']) assert.deepEqual(await require('../src/agent/research/keyed').search(provider, 'topic', options), { skipped: 'credentials-missing' });
});
test('Reddit uses app-only OAuth and maps the authenticated response', async () => {
  const requests = [], responses = [fixture('optional-provider-examples.json').redditToken, fixture('optional-provider-examples.json').reddit];
  const results = await require('../src/agent/research/reddit').search('agents', {
    env: { REDDIT_CLIENT_ID: 'test-id', REDDIT_CLIENT_SECRET: 'test-secret' },
    fetch: async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify(responses.shift())); }
  });
  assert.equal(requests[0].options.body, 'grant_type=client_credentials');
  assert.equal(requests[0].options.headers.Authorization, 'Basic ' + Buffer.from('test-id:test-secret').toString('base64'));
  assert.equal(requests[1].options.headers.Authorization, 'Bearer fixture-oauth-token');
  assert.equal(new URL(requests[1].url).hostname, 'oauth.reddit.com');
  assert.equal(results[0].engagement.score, 42);
  assert.equal(results[0].engagement.comments, 7);
});
test('keyed providers use native payloads and do not turn relevance scores into engagement', async () => {
  const examples = fixture('optional-provider-examples.json');
  for (const provider of ['exa', 'tavily', 'brave']) {
    const requests = [];
    const results = await require('../src/agent/research/keyed').search(provider, 'test & topic', {
      env: { EXA_API_KEY: 'test-exa', TAVILY_API_KEY: 'test-tavily', BRAVE_API_KEY: 'test-brave' },
      fetch: jsonFetch(examples[provider], {}, requests)
    });
    assert.equal(results[0].provider, provider);
    assert.deepEqual(results[0].engagement, { score: 0, comments: 0 });
    if (provider === 'exa') assert.equal(requests[0].options.headers['x-api-key'], 'test-exa');
    if (provider === 'tavily') assert.equal(requests[0].options.headers.Authorization, 'Bearer test-tavily');
    if (provider === 'brave') assert.equal(requests[0].options.headers['X-Subscription-Token'], 'test-brave');
  }
});
test('opted-in DuckDuckGo parses nested titles and decodes redirect targets', async () => {
  const html = await fs.readFile(path.join(__dirname, 'fixtures/research/duckduckgo.html'), 'utf8');
  const results = await require('../src/agent/research/duckduckgo').search('RAG', { allowHtmlSearch: true, fetchPage: async () => ({ html }) });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.com/rag?q=one&lang=en');
  assert.equal(results[0].title, 'How RAG works');
});
test('provider JSON byte limits, invalid JSON, deadlines and offline guard apply independently', async () => {
  const { requestJson } = require('../src/agent/research/common');
  await assert.rejects(requestJson('https://example.com', { maxBytes: 10, fetch: jsonFetch({ text: 'a'.repeat(100) }) }), /byte limit/);
  await assert.rejects(requestJson('https://example.com', { fetch: async () => new Response('not json') }), /invalid JSON/);
  await assert.rejects(requestJson('https://example.com', { timeoutMs: 20, fetch: () => new Promise(() => {}) }), /timed out/);
  const previous = process.env.DIAGIF_OFFLINE; process.env.DIAGIF_OFFLINE = '1';
  try { await assert.rejects(require('../src/agent/research/hn').search('topic', { fetch: () => { throw Error('network called'); } }), { code: 'OFFLINE' }); }
  finally { if (previous === undefined) delete process.env.DIAGIF_OFFLINE; else process.env.DIAGIF_OFFLINE = previous; }
});
test('fanout shared deadline terminates a stuck adapter and retains diagnostics', async () => {
  const result = await collectResearch('topic', { providers: ['hn', 'github'], cache: false, deadlineMs: 20,
    adapters: { hn: () => new Promise(() => {}), github: async () => { throw Error('provider failed'); } } });
  assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.some(d => /timed out/.test(d.error.message)));
});
test('page caching reuses extracts, fresh refetches, scout TTL is shorter, and secrets stay out', async t => {
  const root = await fs.mkdtemp(path.join(__dirname, 'fixtures/research/page-cache-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { fetchExtract, search } = require('../src/agent/research/page');
  const { normalizeCandidate } = require('../src/agent/research');
  const [candidate] = await search('Read https://example.com/article.');
  const source = normalizeCandidate(candidate);
  let calls = 0, now = 1000000000;
  const previous = process.env.RESEARCH_TEST_SECRET; process.env.RESEARCH_TEST_SECRET = 'fixture-secret-value';
  try {
    const cache = new ResearchCache({ cacheDir: root, now: () => now });
    const options = { cache, fetchPage: async url => { calls++; return { finalUrl: url, html: '<article>Here are four words. fixture-secret-value</article>' }; } };
    const first = await fetchExtract(source, options);
    assert.equal(first.cached, false);
    assert.equal((await fetchExtract(source, options)).cached, true);
    assert.equal(calls, 1);
    await fetchExtract(source, { ...options, fresh: true }); assert.equal(calls, 2);
    now += 6 * 3600000;
    await fetchExtract(source, { ...options, purpose: 'scout' }); assert.equal(calls, 3);
    assert.doesNotMatch(await fs.readFile(cache.pathFor(source.url), 'utf8'), /fixture-secret-value/);
    assert.equal(first.contentHash, require('../src/agent/research/common').hash(first.text));
  } finally { if (previous === undefined) delete process.env.RESEARCH_TEST_SECRET; else process.env.RESEARCH_TEST_SECRET = previous; }
});
test('fanout isolates errors, deduplicates canonical URLs, caps candidates and extracts pages', async () => {
  const result = await collectResearch('topic', {
    providers: ['hn', 'github', 'page'], cache: false,
    adapters: {
      hn: async () => Array.from({ length: 35 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Title ${i}`, provider: 'hn' })),
      github: async () => ({ skipped: 'rate-limited' }),
      page: async () => [{ url: 'https://example.com/0#fragment', title: 'Duplicate', provider: 'page' }]
    },
    fetchPage: async url => ({ finalUrl: url, html: '<article>These are four evidence words.</article>' })
  });
  assert.equal(result.candidates.length, 30);
  assert.equal(result.sources.length, 30);
  assert.equal(result.extracts.length, 30);
  assert.ok(result.diagnostics.some(d => d.provider === 'github' && d.skipped === 'rate-limited'));
  assert.ok(result.sources.every(s => !Object.hasOwn(s, 'excerpt')));
});
test('harness ports expose content hashes, mutate grounded facts, and support mock scout domains', async () => {
  const { selectResearch, assertGrounded, factSheetForSchema } = require('../src/agent/research');
  const selected = selectResearch('mock', { research: { providers: ['page'] } });
  const collected = await selected.collect('explain RAG');
  assert.equal(collected.sources[0].contentHash, collected.extracts[0].contentHash);
  const sheet = structuredClone(collected.factSheet);
  assert.equal(assertGrounded(sheet, collected), sheet);
  assert.equal(sheet.facts[0].quoteOffset, 0);
  assert.ok(sheet.facts[0].extractHash);
  assert.equal(Object.hasOwn(factSheetForSchema(sheet).facts[0], 'extractHash'), false);
  const scout = await selected.collect('software engineering', { scout: true });
  assert.equal(scout.candidates.length, 3);
});
test('grounding rejects a correct source ID paired with another URL or corrupt text hash', () => {
  const first = getMockResearch('explain RAG');
  first.extracts[0].url = 'https://example.com/different';
  assert.throws(() => validateFactSheet(first.factSheet, first.extracts), { code: 'RESEARCH_INSUFFICIENT' });
  const second = getMockResearch('explain RAG'); second.extracts[0].contentHash = '0'.repeat(64);
  assert.throws(() => validateFactSheet(second.factSheet, second.extracts), { code: 'RESEARCH_INSUFFICIENT' });
});
test('aborted collection never starts providers and late pages cannot write cache', async () => {
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(collectResearch('topic', { signal: controller.signal, adapters: { hn: () => { throw Error('must not start'); } }, cache: false }), /cancelled/);
  let release, writes = 0;
  const active = new AbortController();
  const operation = require('../src/agent/research/page').fetchExtract({ id: 'src-example', url: 'https://example.com' }, {
    signal: active.signal, cache: { get: async () => null, set: async () => { writes++; } },
    fetchPage: () => new Promise(resolve => { release = resolve; })
  });
  await new Promise(resolve => setImmediate(resolve)); active.abort(Error('cancelled'));
  await assert.rejects(operation, /cancelled/);
  release({ finalUrl: 'https://example.com', html: '<main>Late content</main>' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(writes, 0);
});
