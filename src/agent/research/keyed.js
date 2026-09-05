'use strict';
const { requestJson, requireSuccess } = require('./common');
const KEYS = { exa: 'EXA_API_KEY', tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY' };
async function search(provider, topic, options = {}) {
  if (!Object.hasOwn(KEYS, provider)) throw new TypeError('Unknown keyed research provider.');
  const key = (options.env || process.env)[KEYS[provider]];
  if (!key) return { skipped: 'credentials-missing' };
  let response;
  if (provider === 'exa') response = await requestJson('https://api.exa.ai/search', { ...options, method: 'POST', headers: { 'x-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: topic, numResults: 10, contents: { text: true } }) });
  else if (provider === 'tavily') response = await requestJson('https://api.tavily.com/search', { ...options, method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: topic, max_results: 10 }) });
  else response = await requestJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(topic)}&count=10`, { ...options, headers: { 'X-Subscription-Token': key } });
  const data = requireSuccess(response), results = provider === 'brave' ? data?.web?.results : data?.results;
  if (!Array.isArray(results)) throw new TypeError(`${provider} response has no results array.`);
  return results.map(item => ({ url: item.url, title: item.title, provider, publishedAt: item.publishedDate || item.published_date || null,
    engagement: { score: 0, comments: 0 }, excerpt: item.text || item.content || item.description || '' }));
}
module.exports = { search, exa: (topic, options) => search('exa', topic, options), tavily: (topic, options) => search('tavily', topic, options), brave: (topic, options) => search('brave', topic, options) };
