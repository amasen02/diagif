'use strict';

const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { writeFileAtomic } = require('../../fs-atomic');
const { redact } = require('../redact');
const { toWireSchema } = require('../schemas/wire');
const errors = require('../errors');

function wireFor(request, dialect) {
  if (request.step !== 'scene') return { schema: toWireSchema(request.schema, dialect), dialect, strict: dialect === 'openai-strict' };
  const original = request.schema;
  const loose = { ...original, properties: { ...original.properties, scene: { type: 'object', additionalProperties: true } } };
  const schema = toWireSchema(loose, dialect);
  schema.properties.scene = { type: 'object', additionalProperties: true };
  return { schema, dialect, strict: false };
}
function usage(inputTokens = null, outputTokens = null, price) {
  return { inputTokens, outputTokens, costUsd: price && inputTokens !== null && outputTokens !== null ? (inputTokens * price.input + outputTokens * price.output) / 1e6 : null,
    costSource: price && inputTokens !== null && outputTokens !== null ? 'price-table' : 'none' };
}
function offline(env = process.env) { if (env.DIAGIF_OFFLINE === '1') throw new errors.AgentOfflineError('Live model providers are disabled by DIAGIF_OFFLINE=1'); }
function classifyFailure(message, status) {
  const safe = redact(String(message)).split(/\r?\n/).filter(line => !/AuthRequired|Transport channel closed/.test(line)).join('\n');
  if (/You've hit your usage limit|insufficient_quota|quota|credit balance|rate.?limit|overloaded/i.test(message) || status === 429) return new errors.AgentQuotaError(safe);
  if (/unauthori[sz]ed|authentication|invalid.?api.?key|not logged in|login required|sign in/i.test(message) || status === 401 || status === 403) return new errors.AgentAuthError(safe);
  return new errors.AgentProviderError(safe || 'Provider failed', { retryable: status >= 500 });
}
async function postJson(url, headers, body, { env = process.env, fetch: fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  offline(env);
  try {
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    if (!response.ok) throw classifyFailure(text, response.status);
    try { return JSON.parse(text); } catch { throw new errors.AgentProviderError('Provider returned a non-JSON response'); }
  } catch (error) {
    if (error instanceof errors.AgentError) throw error;
    throw new errors.AgentProviderError('Provider transport failed: ' + error.message, { retryable: true, cause: error });
  }
}
async function imageData(image) {
  if (typeof image === 'object' && image.data) return image.data;
  return (await fs.readFile(typeof image === 'string' ? image : image.path)).toString('base64');
}
function promptText(request) {
  return [request.system || '', ...(request.messages || []).map(message => message.role + ': ' + (typeof message.content === 'string' ? message.content : JSON.stringify(message.content))),
    'Return one complete JSON object satisfying the ORIGINAL schema:', JSON.stringify(request.schema),
    ...(request.step === 'scene' ? ['Scene schema referenced by the proposal:', JSON.stringify(require('../../schema/scene.schema.json'))] : [])].join('\n\n');
}
async function runProcess(command, args, { input = '', timeoutMs = 240000, cwd, env = process.env, spawn: spawnImpl = spawn, platform = process.platform, stderrPath } = {}) {
  offline(env);
  if (/\.(cmd|bat|ps1)$/i.test(command)) throw new errors.AgentProviderUnavailable('Provider must resolve to a real executable or a Node JS entrypoint');
  const result = await new Promise((resolve, reject) => {
    let child, stdout = '', stderr = '', timedOut = false, failure, treeKill = Promise.resolve();
    const controller = new AbortController();
    try { child = spawnImpl(command, args, { shell: false, windowsHide: true, signal: controller.signal, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'], cwd, env }); }
    catch (error) { reject(classifyFailure(error.message)); return; }
    function stop() {
      timedOut = true;
      if (platform === 'win32' && child.pid) treeKill = new Promise(done => {
        try { const killer = spawnImpl('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }); killer.once('error', done); killer.once('close', done); } catch { done(); }
      });
      controller.abort();
    }
    const timer = setTimeout(stop, timeoutMs);
    const collect = key => chunk => {
      if (key === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > 8 * 1024 * 1024 && !timedOut) { failure = new errors.AgentProviderError('Provider output exceeds 8 MiB'); stop(); }
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => { failure ||= timedOut ? null : classifyFailure(error.message); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') failure ||= classifyFailure(error.message); });
    child.once('close', async (code, signal) => { clearTimeout(timer); await treeKill; resolve({ stdout, stderr, code, signal, timedOut, failure }); });
    child.stdin.end(input);
  });
  if (stderrPath) await writeFileAtomic(stderrPath, redact(result.stderr, env), { mode: 0o600 });
  if (result.failure) throw result.failure;
  if (result.timedOut) throw new errors.AgentProviderError('Provider timed out');
  return result;
}
function endpoint(base, suffix) { return (base || '').replace(/\/$/, '') + suffix; }
module.exports = { wireFor, usage, offline, classifyFailure, postJson, imageData, promptText, runProcess, endpoint };
