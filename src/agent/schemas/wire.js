'use strict';

const { AgentSchemaError, WireSchemaTooLarge } = require('../errors.js');
const stripped = key => /^(?:min|max)/.test(key) ||
  ['format', 'pattern', 'multipleOf', 'uniqueItems', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key);

function toWireSchema(schema, dialect) {
  if (dialect === 'none') return schema;
  if (!['openai-strict', 'anthropic'].includes(dialect)) throw new AgentSchemaError('Unknown wire dialect: ' + dialect);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new AgentSchemaError('Wire schema must be an object');
  let propertyCount = 0;
  let maxDepth = 0;

  function project(input, depth, refs = []) {
    if (typeof input === 'boolean') return input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentSchemaError('Invalid schema node');
    if (input.$ref !== undefined) {
      const ref = input.$ref;
      if (typeof ref !== 'string' || !ref.startsWith('#/')) throw new AgentSchemaError('Only local JSON pointer refs can be projected: ' + ref);
      if (refs.includes(ref)) throw new AgentSchemaError('Recursive wire schema ref: ' + ref);
      let target = schema;
      for (const part of ref.slice(2).split('/').map(s => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'))) {
        if (!target || !Object.hasOwn(target, part)) throw new AgentSchemaError('Unresolved wire schema ref: ' + ref);
        target = target[part];
      }
      const { $ref, ...siblings } = input;
      return project({ ...target, ...siblings }, depth, [...refs, ref]);
    }
    const result = {};
    const notes = [];
    const types = Array.isArray(input.type) ? input.type : [input.type];
    const container = input.properties !== undefined || types.includes('object') || types.includes('array');
    const level = depth + (container ? 1 : 0);
    maxDepth = Math.max(maxDepth, level);
    for (const [key, value] of Object.entries(input)) {
      if (['$id', '$schema', '$defs', 'definitions', 'default', 'required', 'properties', 'additionalProperties'].includes(key)) continue;
      if (stripped(key)) { notes.push(`(${key} ${JSON.stringify(value)})`); continue; }
      if (['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames'].includes(key)) result[key] = project(value, level, refs);
      else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(key)) result[key === 'oneOf' ? 'anyOf' : key] = value.map(branch => project(branch, level, refs));
      else result[key] = structuredClone(value);
    }
    if (input.properties !== undefined || types.includes('object')) {
      result.type ??= 'object';
      result.properties = {};
      result.additionalProperties = false;
      const required = new Set(input.required || []);
      for (const [name, value] of Object.entries(input.properties || {})) {
        propertyCount++;
        const child = project(value, level, refs);
        // Enum/const and composed schemas need an explicit null branch: a type
        // union alone would still reject null through their other constraints.
        result.properties[name] = required.has(name) ? child : nullable(child);
      }
      result.required = Object.keys(result.properties);
    }
    if (notes.length) result.description = [result.description, ...notes].filter(Boolean).join(' ');
    return result;
  }
  const output = project(schema, 0);
  if (dialect === 'openai-strict') {
    if (output.anyOf) throw new AgentSchemaError('OpenAI strict schemas cannot have root anyOf');
    if (propertyCount > 100 || maxDepth > 5) throw new WireSchemaTooLarge('Wire schema exceeds 100 properties or 5 levels', { details: { propertyCount, maxDepth } });
  }
  return output;
}

function nullable(schema) {
  if (schema === true) return true;
  if (schema === false) return { type: 'null' };
  if (schema.enum || Object.hasOwn(schema, 'const') || schema.anyOf || schema.allOf || schema.not || !schema.type) {
    return { anyOf: [schema, { type: 'null' }] };
  }
  return { ...schema, type: [...new Set([...(Array.isArray(schema.type) ? schema.type : [schema.type]), 'null'])] };
}

module.exports = { toWireSchema };
