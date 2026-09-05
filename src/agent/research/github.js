'use strict';
const { requestJson, requireSuccess } = require('./common');
async function search(topic, options = {}) {
  const url = new URL('https://api.github.com/search/repositories');
  url.search = new URLSearchParams({ q: topic, sort: 'stars', order: 'desc', per_page: '10' }).toString();
  const response = await requestJson(url.href, options);
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || /secondary.{0,30}(?:rate\s*)?limit/i.test(response.text)))) return { skipped: 'rate-limited' };
  const data = requireSuccess(response);
  if (!Array.isArray(data?.items)) throw new TypeError('GitHub response has no items array.');
  return data.items.map(repo => ({ url: repo.html_url, title: repo.full_name || repo.name, provider: 'github', publishedAt: repo.created_at,
    engagement: { score: repo.stargazers_count, comments: repo.open_issues_count }, excerpt: repo.description || '' }));
}
module.exports = { search };
