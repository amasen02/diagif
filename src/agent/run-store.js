'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileAtomic } = require('../fs-atomic');
const { redact } = require('./redact');
const { validateValue } = require('./brains/schema');
const { AgentUsageError, AgentResumeMismatch } = require('./errors');
const { configProjection, loadConfig } = require('./config');
const runSchema = require('./schemas/run.schema.json');

function stableStringify(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ?
    Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value));
}
function hash(...values) { return createHash('sha256').update(stableStringify(values.length === 1 ? values[0] : values)).digest('hex'); }
function hashFile(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function slugify(topic) {
  let slug = String(topic).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70).replace(/-$/, '');
  if (!slug) slug = 'topic-' + hash(topic).slice(0, 10);
  if (slug.length === 1) slug += '-topic';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) slug += '-topic';
  return slug;
}
function uniqueSlug(base, outDir) {
  const initial = slugify(base);
  fs.mkdirSync(outDir, { recursive: true });
  for (let suffix = 1; ; suffix++) {
    const slug = suffix === 1 ? initial : initial + '-' + suffix;
    // Reserve atomically so simultaneous CLI processes cannot mix run artifacts.
    try { fs.mkdirSync(path.join(outDir, slug)); return slug; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value) || value.split('/').some(part => ['..', '.', ''].includes(part))) {
    throw new AgentUsageError('Artifact paths must be relative paths without traversal');
  }
  return value;
}
function newRun(options = {}) {
  const config = options.config || loadConfig({ cwd: options.cwd });
  return { schemaVersion: 1, runId: options.runId || randomUUID(), slug: options.slug || slugify(redact(options.topic || 'untitled')),
    ...(options.parentSlug ? { parentSlug: options.parentSlug } : {}), command: options.command || 'make', topic: options.topic || '', status: 'running',
    startedAt: options.startedAt || new Date().toISOString(), config: configProjection(config, options.brain, options),
    budget: { maxModelCalls: options.maxModelCalls || config.limits.maxModelCalls, modelCallsUsed: 0,
      ...(options.maxTotalModelCalls ? { maxTotalModelCalls: options.maxTotalModelCalls } : {}) },
    steps: [], modelCalls: [], sources: [], claims: [], criticImages: [], artifacts: {}, gates: { schema: null, browser: null, render: null, critic: null } };
}
function validateRun(run) {
  validateValue(runSchema, run);
  if (run.budget.modelCallsUsed > run.budget.maxModelCalls) throw new AgentUsageError('Run budget exceeds its limit');
  for (const file of [...Object.values(run.artifacts), ...run.criticImages, ...run.steps.map(step => step.outputPath)]) relativePath(file);
  return run;
}
function createRunStore(directory, { env = process.env } = {}) {
  const root = path.resolve(directory);
  const stepsDir = path.join(root, 'steps');
  fs.mkdirSync(stepsDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'internal'), { recursive: true });
  let queue = Promise.resolve();
  const target = file => path.join(root, relativePath(file));
  const serial = operation => { const pending = queue.then(operation); queue = pending.catch(() => {}); return pending; };
  async function writeJson(file, value) {
    const safe = redact(value, env);
    await writeFileAtomic(target(file), JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
    return { outputPath: file, outputHash: hash(safe) };
  }
  function persist(run) {
    const safe = redact(run, env);
    validateRun(safe);
    return serial(() => writeFileAtomic(target('run.json'), JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 }));
  }
  async function persistStep(name, value, metadata = {}) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) throw new AgentUsageError('Invalid step artifact name');
    const output = await writeJson('steps/' + name + '.json', value);
    return { name, status: 'success', attempt: 1, inputHash: metadata.inputHash || '', startedAt: new Date().toISOString(), ...metadata, ...output };
  }
  function readJson(file) { return JSON.parse(fs.readFileSync(target(file), 'utf8')); }
  async function writeText(file, text) { await writeFileAtomic(target(file), redact(String(text), env), { mode: 0o600 }); return file; }
  function reusableStep(run, name, inputHash) {
    const step = [...run.steps].reverse().find(item => item.name === name && ['success', 'reused'].includes(item.status) && item.accepted !== false && item.inputHash === inputHash);
    if (!step) return null;
    try { const value = readJson(step.outputPath); return hash(value) === step.outputHash ? { ...step, status: 'reused', value } : null; } catch { return null; }
  }
  return { root, dir: root, runDir: root, stepsDir, internalDir: path.join(root, 'internal'), path: target, persist, persistRun: persist, writeRun: persist,
    persistStep, writeJson, writeText, readJson, loadRun: () => validateRun(readJson('run.json')), reusableStep };
}
function resolveResume(outDir, topic, slug) {
  if (slug) {
    if (slugify(slug) !== slug) throw new AgentResumeMismatch('Invalid resume slug');
    const file = path.join(outDir, slug, 'run.json');
    try { const run = validateRun(JSON.parse(fs.readFileSync(file, 'utf8'))); if (run.topic.normalize('NFKC').trim().toLowerCase() === topic.normalize('NFKC').trim().toLowerCase()) return slug; } catch (error) { if (error instanceof AgentResumeMismatch) throw error; }
    throw new AgentResumeMismatch('Resume run is missing, invalid or belongs to a different topic');
  }
  const matches = [];
  if (fs.existsSync(outDir)) for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { if (resolveResume(outDir, topic, entry.name)) matches.push(entry.name); } catch {}
  }
  if (matches.length !== 1) throw new AgentResumeMismatch('Expected exactly one matching run', { details: { slugs: matches } });
  return matches[0];
}
module.exports = { createRunStore, newRun, validateRun, slugify, uniqueSlug, hash, hashFile, stableStringify, relativePath, resolveResume };
