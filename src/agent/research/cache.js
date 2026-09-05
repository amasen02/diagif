'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeFileAtomic } = require('../../fs-atomic');
const { hash } = require('./common');
const { toSafeJson } = require('../errors');
function canonicalUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Expected an HTTP(S) URL without credentials.');
  if (url.href.length > 2048) throw new TypeError('URL exceeds 2048 characters.');
  for (const key of url.searchParams.keys()) if (/(?:api[-_]?key|token|secret|password|authorization)/i.test(key)) throw new TypeError('Credential-bearing URLs are not research sources.');
  url.hash = ''; url.hostname = url.hostname.replace(/\.$/, ''); url.searchParams.sort();
  return url.href;
}
function safeRecord(value) {
  let redact;
  try { ({ redact } = require('../redact')); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'../redact'")) throw error;
  }
  if (redact) return redact(value);
  const safe = toSafeJson({ message: '', details: value }).details;
  const secrets = Object.entries(process.env).filter(([key, value]) => /(KEY|TOKEN|SECRET)$/i.test(key) && value).map(([, value]) => value);
  const walk = item => typeof item === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item) :
    Array.isArray(item) ? item.map(walk) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, val]) => [key, walk(val)])) : item;
  return walk(safe);
}
class ResearchCache {
  constructor({ rootDir = process.cwd(), cacheDir = path.join(rootDir, '.cache', 'research'), now = Date.now, cacheTtlDays = 7, scoutCacheTtlHours = 6 } = {}) {
    this.cacheDir = cacheDir; this.now = typeof now === 'function' ? now : () => now;
    this.researchTtl = cacheTtlDays * 86400000; this.scoutTtl = scoutCacheTtlHours * 3600000;
  }
  pathFor(url) { return path.join(this.cacheDir, `${hash(canonicalUrl(url))}.json`); }
  async get(url, { fresh = false, mode = 'research' } = {}) {
    if (fresh) return null;
    try {
      const file = this.pathFor(url);
      if ((await fs.stat(file)).size > 1024 * 1024) return null;
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));
      const age = this.now() - Date.parse(entry.fetchedAt);
      if (!Number.isFinite(age) || age < 0 || age >= (mode === 'scout' ? this.scoutTtl : this.researchTtl) ||
          typeof entry.text !== 'string' || entry.text.length > 40000 || hash(entry.text) !== entry.contentHash || !entry.source) return null;
      canonicalUrl(entry.finalUrl);
      return entry;
    } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError || error instanceof TypeError) return null; throw error; }
  }
  async set(url, { finalUrl = url, text, source }) {
    const entry = safeRecord({ fetchedAt: new Date(this.now()).toISOString(), finalUrl: canonicalUrl(finalUrl), text: String(text).slice(0, 40000), source });
    entry.contentHash = hash(entry.text);
    await writeFileAtomic(this.pathFor(url), JSON.stringify(entry, null, 2) + '\n');
    return entry;
  }
}
module.exports = { ResearchCache, createCache: options => new ResearchCache(options), canonicalUrl, safeRecord };
