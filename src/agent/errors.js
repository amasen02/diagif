'use strict';

const EXIT_CODES = Object.freeze({
  USAGE: 2, SCHEMA: 4, SCENE_REPAIR_EXHAUSTED: 4,
  PROVIDER_UNAVAILABLE: 3, PROVIDER_QUOTA: 3, PROVIDER_AUTH: 3, PROVIDER: 3,
  TRUNCATED: 4, REFUSAL: 4, RENDER: 5, QUALITY_GATE: 5,
  BUDGET_EXHAUSTED: 6, RESUME_MISMATCH: 7, RESEARCH_INSUFFICIENT: 8,
  OFFLINE: 8, WIRE_SCHEMA: 4, MINDMAP_LAYOUT: 4
});

class AgentError extends Error {
  constructor(message, { code = 'SCHEMA', retryable = false, details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = EXIT_CODES[code] ?? 4;
    this.retryable = retryable === true;
    this.details = details;
  }
}

// These remain independent of provider/config modules so they work during startup.
const types = {
  AgentUsageError: 'USAGE', AgentSchemaError: 'SCHEMA',
  AgentSceneRepairExhausted: 'SCENE_REPAIR_EXHAUSTED',
  AgentProviderUnavailable: 'PROVIDER_UNAVAILABLE', AgentQuotaError: 'PROVIDER_QUOTA',
  AgentAuthError: 'PROVIDER_AUTH', AgentProviderError: 'PROVIDER',
  AgentTruncatedError: 'TRUNCATED', AgentRefusalError: 'REFUSAL',
  AgentRenderError: 'RENDER', AgentQualityGateError: 'QUALITY_GATE',
  AgentBudgetExhausted: 'BUDGET_EXHAUSTED', AgentResumeMismatch: 'RESUME_MISMATCH',
  AgentResearchInsufficient: 'RESEARCH_INSUFFICIENT', AgentOfflineError: 'OFFLINE',
  WireSchemaTooLarge: 'WIRE_SCHEMA'
};
const errors = Object.fromEntries(Object.entries(types).map(([name, code]) => {
  const Type = { [name]: class extends AgentError {
    constructor(message = code, options = {}) {
      super(message, { ...options, code, retryable: code === 'PROVIDER' && options.retryable === true });
    }
  } }[name];
  return [name, Type];
}));

function exitCodeFor(error) {
  if (error == null) return 0;
  return Object.hasOwn(EXIT_CODES, error.code) ? EXIT_CODES[error.code] : 4;
}

const secretKey = /^(?:authorization|proxy-authorization|x-api-key|x-subscription-token|.*api[-_]?key|.*access[-_]?token|.*refresh[-_]?token|.*secret|password|cookie|set-cookie)$/i;
function redactText(value) {
  return String(value)
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@')
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|x-api-key|x-subscription-token)["']?\s*[:=]\s*["']?)[^\s&,;"'}]+/gi, '$1[REDACTED]');
}
function safeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return String(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => safeValue(item, seen)) :
    Object.fromEntries(Object.entries(value).filter(([key]) => !['stack', 'cause'].includes(key)).map(([key, item]) =>
      [key, secretKey.test(key) ? '[REDACTED]' : safeValue(item, seen)]));
  seen.delete(value);
  return result;
}
function toSafeJson(error) {
  const code = Object.hasOwn(EXIT_CODES, error?.code) ? error.code : 'SCHEMA';
  return { code, message: redactText(error?.message ?? error ?? 'Unknown error'), details: safeValue(error?.details) ?? null };
}

module.exports = { AgentError, ...errors, EXIT_CODES, exitCodeFor, toSafeJson };
