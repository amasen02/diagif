'use strict';
const { createHash } = require('node:crypto');
const { AgentOfflineError, AgentProviderError } = require('../errors');
const USER_AGENT = 'diagif/0.1 (+https://github.com/amasen02/diagif)';
const hash = value => createHash('sha256').update(value).digest('hex');
function assertOnline() {
  if (process.env.DIAGIF_OFFLINE === '1') throw new AgentOfflineError('Research network access is disabled (DIAGIF_OFFLINE=1).');
}
function problem(message, reason) { return new AgentProviderError(message, { details: { reason } }); }
function deadline(timeoutMs = 15000, parent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(problem('Research request timed out.', 'timeout')), timeoutMs);
  const abort = () => controller.abort(parent.reason || problem('Research request aborted.', 'aborted'));
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}
function bounded(promise, signal) {
  if (signal.aborted) { void Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
// Provider URLs are fixed by adapters. Never use this transport for candidate pages.
async function requestJson(url, options = {}) {
  assertOnline();
  const scope = deadline(options.timeoutMs, options.signal);
  let response;
  try {
    scope.signal.throwIfAborted();
    response = await bounded((options.fetch || globalThis.fetch)(url, {
      method: options.method || 'GET', redirect: 'manual', signal: scope.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body })
    }), scope.signal);
    const cap = Math.min(options.maxBytes || 2 * 1024 * 1024, 2 * 1024 * 1024);
    if (Number(response.headers.get('content-length')) > cap) throw problem('Provider response exceeds byte limit.', 'size');
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
      try {
        for (;;) {
          const { value, done } = await bounded(reader.read(), scope.signal);
          if (done) break;
          size += value.byteLength;
          if (size > cap) throw problem('Provider response exceeds byte limit.', 'size');
          chunks.push(Buffer.from(value));
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let data = null;
    try { data = JSON.parse(text); } catch { if (response.ok) throw problem('Provider returned invalid JSON.', 'json'); }
    return { status: response.status, ok: response.ok, headers: response.headers, data, text };
  } finally { scope.close(); if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
}
function requireSuccess(response) {
  if (!response.ok) throw problem(`Research provider returned HTTP ${response.status}.`, `http-${response.status}`);
  return response.data;
}
module.exports = { USER_AGENT, hash, assertOnline, problem, deadline, bounded, requestJson, requireSuccess };
