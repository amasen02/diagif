'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv/dist/2020');
const { toWireSchema } = require('../src/agent/schemas/wire.js');
const { AgentSchemaError, WireSchemaTooLarge } = require('../src/agent/errors.js');

const source = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:test:wire',
  type: 'object', additionalProperties: false, required: ['facts'],
  $defs: { fact: { type: 'object', required: ['text'], additionalProperties: false,
    properties: { text: { type: 'string', minLength: 1, maxLength: 90, pattern: '^x', default: 'x' },
      score: { type: 'number', minimum: 0, maximum: 10, multipleOf: 1 },
      url: { type: 'string', format: 'uri' } } } },
  properties: { facts: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: { $ref: '#/$defs/fact' } },
    mode: { enum: ['short', 'long'] }, enabled: { type: 'boolean', const: true },
    note: { type: 'string', description: 'Optional note', maxLength: 20 } }
};

for (const dialect of ['openai-strict', 'anthropic']) test(dialect + ' projects refs and constraints without mutating the original', () => {
  const before = structuredClone(source), wire = toWireSchema(source, dialect);
  assert.deepEqual(source, before);
  function inspect(node) {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) assert.ok(!/^\$(?:id|schema|defs|ref)$|^(?:default|format|min\w*|max\w*|pattern|multipleOf|uniqueItems|oneOf)$/.test(key), key);
    if (node.type === 'object' || node.properties) {
      assert.deepEqual(node.required, Object.keys(node.properties));
      assert.equal(node.additionalProperties, false);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') inspect(value);
    }
  }
  inspect(wire);
  assert.match(wire.properties.facts.items.properties.text.description, /maxLength 90/);
  assert.match(wire.properties.note.description, /Optional note.*maxLength 20/);
  const valid = new Ajv({ strict: false }).compile(wire);
  assert.equal(valid({ facts: [{ text: 'x', score: null, url: null }], mode: null, enabled: null, note: null }), true, JSON.stringify(valid.errors));
  assert.equal(valid({ facts: [{ text: 'x' }], mode: null, enabled: null, note: null }), false);
  assert.equal(valid({ facts: [], mode: 'wrong', enabled: true, note: null }), false);
  // The wire deliberately permits lengths that the original acceptance schema rejects.
  assert.equal(valid({ facts: [{ text: '', score: null, url: null }], mode: null, enabled: null, note: null }), true);
  const original = new Ajv({ strict: false, validateFormats: false }).compile(source);
  assert.equal(original({ facts: [{ text: '' }] }), false);
});

test('none preserves original identity; invalid dialect and unresolved or recursive refs fail explicitly', () => {
  assert.equal(toWireSchema(source, 'none'), source);
  assert.throws(() => toWireSchema(source, 'unknown'), AgentSchemaError);
  for (const schema of [{ $ref: '#/$defs/missing' }, { $ref: 'urn:external' },
    { $defs: { recursive: { $ref: '#/$defs/recursive' } }, $ref: '#/$defs/recursive' }]) {
    assert.throws(() => toWireSchema(schema, 'openai-strict'), AgentSchemaError);
  }
});

test('JSON pointer escapes are resolved and enum/const/composed optional properties admit null', () => {
  const wire = toWireSchema({ type: 'object', $defs: { 'a/b~c': { type: 'string' } }, properties: {
    escaped: { $ref: '#/$defs/a~1b~0c' }, choice: { oneOf: [{ type: 'number' }, { type: 'string' }] }
  } }, 'openai-strict');
  const valid = new Ajv({ strict: false }).compile(wire);
  assert.equal(valid({ escaped: null, choice: null }), true);
  assert.equal(valid({ escaped: 'ok', choice: 1 }), true);
  assert.equal(valid({ escaped: 'ok', choice: false }), false);
});

test('strict size limits count inlined properties and container levels at their boundaries', () => {
  const wide = count => ({ type: 'object', properties: Object.fromEntries(Array.from({ length: count }, (_, i) => ['p' + i, { type: 'string' }])) });
  assert.doesNotThrow(() => toWireSchema(wide(100), 'openai-strict'));
  assert.throws(() => toWireSchema(wide(101), 'openai-strict'), WireSchemaTooLarge);
  let deep = { type: 'string' };
  for (let i = 0; i < 5; i++) deep = { type: 'object', properties: { child: deep } };
  assert.doesNotThrow(() => toWireSchema(deep, 'openai-strict'));
  deep = { type: 'array', items: deep };
  assert.throws(() => toWireSchema(deep, 'openai-strict'), WireSchemaTooLarge);
  assert.doesNotThrow(() => toWireSchema(deep, 'anthropic'));
  const repeated = { type: 'object', $defs: { wide: wide(50) }, properties: { a: { $ref: '#/$defs/wide' }, b: { $ref: '#/$defs/wide' } } };
  assert.throws(() => toWireSchema(repeated, 'openai-strict'), WireSchemaTooLarge);
  assert.throws(() => toWireSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] }, 'openai-strict'), /root anyOf/);
});
