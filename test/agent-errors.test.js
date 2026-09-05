'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const errors = require('../src/agent/errors.js');
const { writeFileAtomic, renameWithRetry } = require('../src/fs-atomic.js');

test('typed errors expose the locked codes, names and exit mapping', () => {
  const expected = {
    AgentUsageError: ['USAGE', 2], AgentSchemaError: ['SCHEMA', 4], AgentSceneRepairExhausted: ['SCENE_REPAIR_EXHAUSTED', 4],
    AgentProviderUnavailable: ['PROVIDER_UNAVAILABLE', 3], AgentQuotaError: ['PROVIDER_QUOTA', 3], AgentAuthError: ['PROVIDER_AUTH', 3],
    AgentProviderError: ['PROVIDER', 3], AgentTruncatedError: ['TRUNCATED', 4], AgentRefusalError: ['REFUSAL', 4],
    AgentRenderError: ['RENDER', 5], AgentQualityGateError: ['QUALITY_GATE', 5], AgentBudgetExhausted: ['BUDGET_EXHAUSTED', 6],
    AgentResumeMismatch: ['RESUME_MISMATCH', 7], AgentResearchInsufficient: ['RESEARCH_INSUFFICIENT', 8],
    AgentOfflineError: ['OFFLINE', 8], WireSchemaTooLarge: ['WIRE_SCHEMA', 4]
  };
  for (const [name, [code, exit]] of Object.entries(expected)) {
    const cause = new Error('cause'), error = new errors[name]('failed', { details: { step: 'research' }, cause });
    assert.ok(error instanceof errors.AgentError); assert.ok(error instanceof Error);
    assert.equal(error.name, name); assert.equal(error.code, code); assert.equal(error.exitCode, exit);
    assert.equal(errors.exitCodeFor(error), exit); assert.equal(error.retryable, false); assert.equal(error.cause, cause);
    assert.deepEqual(error.details, { step: 'research' });
  }
  assert.equal(errors.exitCodeFor(null), 0); assert.equal(errors.exitCodeFor(undefined), 0);
  assert.equal(errors.exitCodeFor({ code: 'MINDMAP_LAYOUT' }), 4);
  assert.equal(errors.exitCodeFor(new Error('unknown')), 4);
  assert.equal(new errors.AgentProviderError('transient', { retryable: true }).retryable, true);
  assert.equal(new errors.AgentRefusalError('no', { retryable: true }).retryable, false);
  assert.equal(new errors.AgentQuotaError('quota', { retryable: true }).retryable, false);
});

test('safe errors redact nested secrets, credentials and stacks without changing source details', () => {
  const details = { Authorization: 'Bearer hidden', nested: { OPENAI_API_KEY: 'secret-value', password: 'pass-value',
    headers: { 'x-api-key': 'header-value', 'X-Subscription-Token': 'subscription-value' } },
    stack: 'private stack', cause: { stack: 'nested stack' }, count: 2n,
    lines: ['Bearer opaque-value', 'https://user:pass@example.com/path', 'api_key=hidden-value'] }; // sanitize-allow: redaction fixture
  details.self = details;
  const error = new errors.AgentProviderError('Failed sk-example123456 Authorization: Bearer opaque-value', { details }); // sanitize-allow: redaction fixture
  const safe = errors.toSafeJson(error), encoded = JSON.stringify(safe);
  assert.deepEqual(Object.keys(safe), ['code', 'message', 'details']);
  assert.equal(safe.code, 'PROVIDER'); assert.equal(safe.details.self, '[Circular]');
  assert.doesNotMatch(encoded, /secret-value|pass-value|header-value|subscription-value|opaque-value|user:pass|hidden-value|private stack|nested stack|sk-example/);
  assert.equal(details.nested.password, 'pass-value');
  assert.deepEqual(errors.toSafeJson(new Error('plain')), { code: 'SCHEMA', message: 'plain', details: null });
});

test('atomic writes replace complete files, support parallel writers, and retain old bytes after failure', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gif-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'run.json');
  await writeFileAtomic(file, 'old', { mode: 0o600 });
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  await assert.rejects(writeFileAtomic(file, {}), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.equal(await fs.readFile(file, 'utf8'), 'old');
  const contents = Array.from({ length: 8 }, (_, i) => String(i).repeat(8192));
  await Promise.all(contents.map(value => writeFileAtomic(file, value, { fsync: false })));
  assert.ok(contents.includes(await fs.readFile(file, 'utf8')));
  assert.deepEqual(await fs.readdir(path.dirname(file)), ['run.json']);
  const moved = path.join(dir, 'moved.json');
  await renameWithRetry(file, moved);
  await assert.rejects(renameWithRetry(file, moved), { code: 'ENOENT' });
  assert.ok(contents.includes(await fs.readFile(moved, 'utf8')));
});

test('atomic rename retries only transient errors, for five attempts, without unlinking the destination', async t => {
  const realRename = fs.rename;
  t.after(() => { fs.rename = realRename; });
  let attempts = 0;
  fs.rename = async () => { if (++attempts < 5) throw Object.assign(new Error('busy'), { code: ['EPERM', 'EBUSY', 'EACCES'][attempts % 3] }); };
  await renameWithRetry('from', 'to'); assert.equal(attempts, 5);
  attempts = 0;
  fs.rename = async () => { attempts++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  await assert.rejects(renameWithRetry('from', 'to'), { code: 'EBUSY' }); assert.equal(attempts, 5);
  attempts = 0;
  fs.rename = async () => { attempts++; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await assert.rejects(renameWithRetry('from', 'to'), { code: 'ENOENT' }); assert.equal(attempts, 1);
});
