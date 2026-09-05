'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('../fs-atomic');
const { AgentUsageError } = require('./errors');
const { validateValue } = require('./brains/schema');
const { redact } = require('./redact');
const schema = require('./schemas/config.schema.json');
const DEFAULTS = require('./fixtures/config-defaults.json');

function canonicalizeBrandUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AgentUsageError('Brand URL must be a LinkedIn profile or company HTTPS URL'); }
  if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname) || url.port ||
      url.username || url.password || url.search || url.hash || !/^\/(in|company)\/[A-Za-z0-9._-]{2,}\/?$/.test(url.pathname)) {
    throw new AgentUsageError('Brand URL must be a LinkedIn profile or company HTTPS URL without credentials, query or fragment');
  }
  const canonical = 'https://www.linkedin.com' + url.pathname.replace(/\/$/, '');
  if (canonical.length > 72) throw new AgentUsageError('Brand URL must be at most 72 characters');
  return canonical;
}
function merge(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' ? merge(base[key], value) : structuredClone(value);
  }
  return result;
}
function validateConfig(config) {
  const value = structuredClone(config);
  try { validateValue(schema, value); } catch (cause) { throw new AgentUsageError('Invalid agent configuration', { details: cause.details, cause }); }
  if (value.brand?.style === 'url-footer') value.brand.url = canonicalizeBrandUrl(value.brand.url);
  for (const provider of ['openai', 'anthropic']) {
    const baseUrl = value.brain?.[provider]?.baseUrl;
    if (baseUrl) {
      let url;
      try { url = new URL(baseUrl); } catch { throw new AgentUsageError('Invalid ' + provider + ' base URL'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AgentUsageError('Provider base URL must be HTTP(S) without credentials, query or fragment');
    }
  }
  return value;
}
function discoverConfig(cwd = process.cwd()) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'diagif.config.json');
    if (fs.existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}
function loadConfig(file, options = {}) {
  if (file && typeof file === 'object') { options = file; file = options.config || options.file; }
  const cwd = options.cwd || process.cwd();
  const configPath = file ? path.resolve(cwd, file) : discoverConfig(cwd);
  let authored = { version: 1 };
  if (configPath) {
    try { authored = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (cause) { throw new AgentUsageError('Cannot read agent config: ' + configPath, { cause }); }
  }
  authored = validateConfig(authored);
  const defaults = structuredClone(DEFAULTS);
  // Absence of a configured provider enables the documented availability ladder.
  delete defaults.brain.provider;
  const config = merge(defaults, authored);
  Object.defineProperties(config, { configPath: { value: configPath }, configDir: { value: configPath ? path.dirname(configPath) : path.resolve(cwd) } });
  return config;
}
async function saveConfig(file, config) {
  if (typeof file === 'object') { [config, file] = [file, config || file.configPath || 'diagif.config.json']; }
  const value = validateConfig(redact(config));
  await writeFileAtomic(path.resolve(file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return value;
}
function configProjection(config, brain = {}, options = {}) {
  const provider = brain.provider || brain.name || config.brain?.provider || 'mock';
  const key = { 'codex-cli': 'codex', 'claude-cli': 'claudeCli' }[provider] || provider;
  const settings = config.brain?.[key] || {};
  const result = { provider, model: brain.model || settings.model || 'mock', researchProviders: config.research?.providers || ['hn', 'github', 'page'],
    researchMode: options.researchMode || options.research || (provider.startsWith('mock') ? 'mock' : 'live'), brandStyle: config.brand?.style || 'none', limits: config.limits };
  if (settings.baseUrl || ['openai', 'anthropic'].includes(provider)) result.baseUrl = settings.baseUrl || (provider === 'openai' ? 'https://api.openai.com' : 'https://api.anthropic.com');
  return result;
}
module.exports = { loadConfig, saveConfig, discoverConfig, validateConfig, canonicalizeBrandUrl, canonicaliseBrandUrl: canonicalizeBrandUrl, configProjection, DEFAULTS };
