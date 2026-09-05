'use strict';
const { requestJson, requireSuccess } = require('./common');
async function search(topic, options = {}) {
  const env = options.env || process.env;
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) return { skipped: 'credentials-missing' };
  const token = requireSuccess(await requestJson('https://www.reddit.com/api/v1/access_token', {
    ...options, method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  }));
  if (typeof token?.access_token !== 'string' || !token.access_token) throw new TypeError('Reddit OAuth response has no access token.');
  const url = new URL('https://oauth.reddit.com/search');
  url.search = new URLSearchParams({ q: topic, sort: 'top', t: 'month', limit: '20' }).toString();
  const data = requireSuccess(await requestJson(url.href, { ...options, headers: { Authorization: `Bearer ${token.access_token}` } }));
  if (!Array.isArray(data?.data?.children)) throw new TypeError('Reddit response has no children array.');
  return data.data.children.map(({ data: post }) => ({ url: post.url || `https://www.reddit.com${post.permalink}`, title: post.title, provider: 'reddit',
    publishedAt: Number.isFinite(post.created_utc) ? new Date(post.created_utc * 1000).toISOString() : null,
    engagement: { score: post.ups, comments: post.num_comments }, excerpt: post.selftext || '' }));
}
module.exports = { search };
