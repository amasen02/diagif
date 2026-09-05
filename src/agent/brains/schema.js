'use strict';

const Ajv = require('ajv/dist/2020');
const { AgentSchemaError } = require('../errors');
const validators = new WeakMap();
function createAjv() {
  const ajv = new Ajv({ allErrors: true, strict: true, discriminator: true });
  ajv.addFormat('uri', value => { try { return Boolean(new URL(value).protocol); } catch { return false; } });
  ajv.addFormat('date-time', value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    // UTC timestamps do not populate the optional numeric-offset groups.  Convert
    // captures individually so `Z` is treated as a zero offset rather than an
    // absent value flowing into the range checks.
    const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] = match;
    const [y, m, d, h, min, sec, zh, zm] = [year, month, day, hour, minute, second, zoneHour ?? '0', zoneMinute ?? '0'].map(Number);
    return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate() && h < 24 && min < 60 && sec < 60 && zh < 24 && zm < 60;
  });
  return ajv;
}
function normaliseErrors(errors = []) {
  return errors.map(({ instancePath, keyword, message, params }) => ({ path: instancePath || '/', keyword, message, params }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'));
}
function validateValue(schema, value) {
  let validate = validators.get(schema);
  if (!validate) {
    const ajv = createAjv();
    if (JSON.stringify(schema).includes('urn:diagif:scene')) {
      const scene = structuredClone(require('../../schema/scene.schema.json'));
      scene.$id = 'urn:diagif:scene';
      ajv.addSchema(scene);
    }
    validate = ajv.compile(schema);
    validators.set(schema, validate);
  }
  if (!validate(value)) throw new AgentSchemaError('Response does not satisfy the original schema', { details: normaliseErrors(validate.errors) });
  return value;
}
module.exports = { createAjv, validateValue, normaliseErrors };
