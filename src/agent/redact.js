'use strict';

const REDACTED = '[REDACTED]';
const sensitive = /^(?:authorization|proxy-authorization|x-api-key|x-subscription-token|cookie|set-cookie|password|.*(?:api[-_]?key|token|secret))$/i;
function redact(value, env = process.env) {
  const secrets = Object.entries(env).filter(([key, val]) => /(KEY|TOKEN|SECRET)$/i.test(key) && typeof val === 'string' && val.length)
    .map(([, val]) => val).sort((a, b) => b.length - a.length);
  function text(input) {
    let result = input;
    for (const secret of secrets) result = result.split(secret).join(REDACTED);
    return result.replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, REDACTED)
      .replace(/\b(Bearer|Basic)\s+(?!\[REDACTED\])[^\s,;"']+/gi, '$1 ' + REDACTED)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, '$1' + REDACTED + '@')
      .replace(/((?:authorization|x-api-key|x-subscription-token|api[-_]?key|access[-_]?token|secret|password)["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s&,;"'}]+/gi, '$1' + REDACTED);
  }
  const seen = new WeakSet();
  function visit(item) {
    if (typeof item === 'string') return text(item);
    if (typeof item === 'bigint') return String(item);
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    const result = Array.isArray(item) ? item.map(visit) : Object.fromEntries(Object.entries(item)
      .filter(([key]) => !['stack', 'cause'].includes(key))
      .map(([key, val]) => [text(key), sensitive.test(key) ? REDACTED : visit(val)]));
    seen.delete(item);
    return result;
  }
  return visit(value);
}
module.exports = { redact, REDACTED };
