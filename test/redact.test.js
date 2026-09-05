'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/agent/redact');
test('environment secrets are removed from values, substrings and keys without mutating input', () => {
  const value = { value: ['private-value', 'error: private-value'], 'private-value': true };
  assert.deepEqual(redact(value, { CUSTOM_SECRET: 'private-value' }), { value: ['[REDACTED]', 'error: [REDACTED]'], '[REDACTED]': true });
  assert.equal(value.value[0], 'private-value');
});
test('all key/token/secret suffixes are covered; empty variables do not damage text', () => {
  assert.equal(redact('one two three normal', { A_KEY: 'one', B_TOKEN: 'two', C_SECRET: 'three', EMPTY_KEY: '', NORMAL: 'normal' }), '[REDACTED] [REDACTED] [REDACTED] normal');
});
test('headers, key shapes, URL userinfo and bearer logs never leak', () => {
  const value = redact({ Authorization: 'Bearer abc', 'x-api-key': 'abc', 'X-Subscription-Token': 'abc', log: 'Bearer abc https://user:password@example.com/x ' + ['sk', 'abcdefghijk'].join('-') + ' github_pat_fixture' }, {});
  for (const key of ['Authorization', 'x-api-key', 'X-Subscription-Token']) assert.equal(value[key], '[REDACTED]');
  assert.equal(value.log, 'Bearer [REDACTED] https://[REDACTED]@example.com/x [REDACTED] [REDACTED]');
});
test('cycles and errors are safe and redaction is idempotent', () => {
  const value = { message: 'token=visible', stack: 'private stack', cause: 'private cause' }; value.self = value;
  const safe = redact(value, {}); assert.equal(safe.self, '[Circular]'); assert.equal(safe.stack, undefined);
  assert.deepEqual(redact(safe, {}), safe);
});
