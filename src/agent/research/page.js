'use strict';
const { fetchPage } = require('./fetch');
const { extractText } = require('./extract');
const { canonicalUrl, ResearchCache, safeRecord } = require('./cache');
const { hash, assertOnline, bounded } = require('./common');
async function search(topic) {
  const urls = String(topic).match(/https?:\/\/[^\s<>"']+/g) || [];
  return urls.flatMap(input => {
    try { const url = canonicalUrl(input.replace(/[),.;]+$/, '')); return [{ url, title: url, provider: 'page', publishedAt: null, engagement: { score: 0, comments: 0 }, excerpt: '' }]; }
    catch { return []; }
  });
}
async function fetchExtract(source, options = {}) {
  assertOnline();
  options.signal?.throwIfAborted();
  const cache = options.cache === false ? null : options.cache || new ResearchCache(options);
  const cached = await cache?.get(source.url, { fresh: options.fresh, mode: options.purpose || 'research' });
  let entry = cached;
  if (!entry) {
    const pending = (options.fetchPage || fetchPage)(source.url, options);
    const response = await (options.signal ? bounded(pending, options.signal) : pending);
    options.signal?.throwIfAborted();
    const text = safeRecord(extractText(response.html));
    entry = { finalUrl: response.finalUrl, text, contentHash: hash(text), source };
    if (cache) entry = await cache.set(source.url, entry);
  }
  return { sourceId: source.id, url: source.url, finalUrl: entry.finalUrl, text: entry.text, contentHash: entry.contentHash, cached: Boolean(cached) };
}
module.exports = { search, fetchExtract };
