'use strict';
const { requestJson, requireSuccess } = require('./common');
async function search(topic, options = {}) {
  const url = new URL('https://hn.algolia.com/api/v1/search_by_date');
  url.search = new URLSearchParams({ tags: 'story', hitsPerPage: '20', query: topic }).toString();
  const data = requireSuccess(await requestJson(url.href, options));
  if (!Array.isArray(data?.hits)) throw new TypeError('HN response has no hits array.');
  return data.hits.map(hit => ({ url: hit.url || `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`, title: hit.title,
    provider: 'hn', publishedAt: hit.created_at, engagement: { score: hit.points, comments: hit.num_comments }, excerpt: hit.story_text || '' }));
}
module.exports = { search };
