'use strict';
const { hash } = require('./common');
function loadParser(requireFn = require) {
  try {
    const loaded = requireFn('linkedom');
    return typeof loaded?.parseHTML === 'function' ? loaded.parseHTML : null;
  } catch {
    return null;
  }
}
const parseHTML = loadParser();
const DROP = new Set(['script', 'style', 'nav', 'footer', 'aside', 'form', 'template', 'noscript']);
const BLOCK = new Set(['article', 'main', 'body', 'div', 'section', 'header', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'ul', 'ol', 'blockquote', 'pre', 'tr', 'table', 'dl', 'dt', 'dd', 'hr']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', laquo: '«', raquo: '»', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c', eacute: 'é', Eacute: 'É', aacute: 'á', ouml: 'ö', uuml: 'ü', agrave: 'à', rarr: '→', larr: '←', le: '≤', ge: '≥', ne: '≠' };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return ENTITIES[entity] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}
function attributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  return attrs;
}
// Deliberately small fallback: tokenize tags with quoted attributes, build a tree,
// and skip raw-text elements without executing or fetching any document content.
function tokenize(html) {
  const root = { name: 'root', attrs: {}, children: [] }, stack = [root];
  const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[A-Za-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g;
  let raw = null;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    if (raw) { if (new RegExp(`^</${raw}\\s*>$`, 'i').test(token)) raw = null; continue; }
    if (token.startsWith('<!')) continue;
    const closing = /^<\/([\w-]+)/.exec(token);
    if (closing) {
      const name = closing[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      continue;
    }
    const opening = /^<([\w-]+)/.exec(token);
    if (opening) {
      const name = opening[1].toLowerCase();
      if (['script', 'style', 'noscript'].includes(name)) { raw = name; continue; }
      // Common optional HTML end tags; the fallback is not an HTML5 parser.
      if (['p', 'li', 'dt', 'dd'].includes(name) && stack.at(-1).name === name) stack.pop();
      const node = { name, attrs: attributes(token.slice(opening[0].length, -1)), children: [] };
      stack.at(-1).children.push(node);
      if (!VOID.has(name) && !token.endsWith('/>')) stack.push(node);
    } else stack.at(-1).children.push(decodeEntities(token).replace(/[\s\u00a0]+/g, ' '));
  }
  return root;
}
function hidden(node) { return DROP.has(node.name) || Object.hasOwn(node.attrs, 'hidden') || node.attrs['aria-hidden']?.toLowerCase() === 'true'; }
function internalText(html) {
  const root = tokenize(html), preferred = {};
  const queue = [root];
  while (queue.length) {
    const node = queue.pop();
    if (typeof node === 'string' || hidden(node)) continue;
    if (!preferred[node.name]) preferred[node.name] = node;
    for (let i = node.children.length - 1; i >= 0; i--) queue.push(node.children[i]);
  }
  const work = [preferred.article || preferred.main || preferred.body || root], parts = [];
  while (work.length) {
    const node = work.pop();
    if (typeof node === 'string') { parts.push(node, ' '); continue; }
    if (hidden(node)) continue;
    const boundary = BLOCK.has(node.name) ? '\n' : ' ';
    parts.push(boundary); work.push(boundary);
    for (let i = node.children.length - 1; i >= 0; i--) work.push(node.children[i]);
  }
  return parts.join('');
}
function domText(html) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll('script,style,nav,footer,aside,form,template,noscript,[hidden],[aria-hidden]')) {
    if (!node.hasAttribute('aria-hidden') || node.getAttribute('aria-hidden').toLowerCase() === 'true' || node.hasAttribute('hidden') || DROP.has(node.localName)) node.remove();
  }
  // linkedom's `document.body` getter assumes an HTML document and throws for
  // title/excerpt fragments and plain text. querySelector is safe for both
  // document shapes; falling back to the document preserves fragment children.
  const body = document.querySelector('body');
  const root = document.querySelector('article') || document.querySelector('main') || (body?.childNodes.length ? body : document);
  const stack = [root], parts = [];
  while (stack.length) {
    const node = stack.pop();
    if (typeof node === 'string') { parts.push(node); continue; }
    if (node.nodeType === 3) { parts.push(node.nodeValue.replace(/[\s\u00a0]+/g, ' '), ' '); continue; }
    if (node.nodeType !== 1 && node.nodeType !== 9) continue;
    const boundary = BLOCK.has(node.localName) ? '\n' : ' ';
    parts.push(boundary); stack.push(boundary);
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push(child);
  }
  return parts.join('');
}
function extractText(html, { parser = 'auto' } = {}) {
  const text = parseHTML && parser !== 'internal' ? domText(String(html)) : internalText(String(html));
  return text.split('\n').map(line => line.replace(/[\s\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, 40000).trim();
}
function norm(value) {
  return String(value).normalize('NFKC').replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-').replace(/…/g, '...').replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/[\s\u00a0]+/g, ' ').toLowerCase().trim();
}
function isGrounded(quote, extract) {
  const q = norm(quote);
  return q.length >= 12 && q.split(' ').length >= 4 && norm(extract).includes(q);
}
function grounding(quote, text) {
  return isGrounded(quote, text) ? { quoteOffset: norm(text).indexOf(norm(quote)), extractHash: hash(text) } : null;
}
module.exports = { extractText, extract: extractText, norm, isGrounded, grounding, decodeEntities, tokenize, loadParser };
