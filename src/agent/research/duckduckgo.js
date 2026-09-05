'use strict';
const { fetchPage } = require('./fetch');
const { extractText, tokenize } = require('./extract');
function parseResults(html) {
  const root = tokenize(html), work = [root], results = [];
  while (work.length) {
    const node = work.pop();
    if (typeof node === 'string') continue;
    for (let i = node.children.length - 1; i >= 0; i--) work.push(node.children[i]);
    if (node.name !== 'a' || !/(?:^|\s)result-link(?:\s|$)/.test(node.attrs.class || '') || !node.attrs.href) continue;
    try {
      const link = new URL(node.attrs.href, 'https://lite.duckduckgo.com');
      const url = link.searchParams.get('uddg') || link.href;
      const plain = [], stack = [...node.children].reverse();
      while (stack.length) { const item = stack.pop(); if (typeof item === 'string') plain.push(item); else for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]); }
      results.push({ url, title: extractText(plain.join(' ')), provider: 'duckduckgo', publishedAt: null, engagement: { score: 0, comments: 0 }, excerpt: '' });
    } catch { /* Malformed search links are not candidates. */ }
  }
  return results;
}
async function search(topic, options = {}) {
  if (!options.allowHtmlSearch) return { skipped: 'html-search-disabled' };
  const response = await (options.fetchPage || fetchPage)(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(topic)}`, options);
  return parseResults(response.html);
}
module.exports = { search, parseResults };
