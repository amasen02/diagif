'use strict';

const path = require('node:path');
const { writeFileAtomic } = require('../../fs-atomic');
const { redact } = require('../redact');
const { resolveExecutable } = require('../exec-resolve');
const { AgentProviderUnavailable, AgentProviderError, AgentSchemaError, AgentTruncatedError } = require('../errors');
const { wireFor, usage, offline, classifyFailure, promptText, runProcess } = require('./common');
function supportedVersion(version, platform) {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(version || '');
  if (!match) return false;
  const actual = match.slice(1).map(Number), minimum = [2, 1, platform === 'win32' ? 211 : 205];
  for (let i = 0; i < 3; i++) if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  return true;
}
async function createClaudeBrain(config = {}, options = {}) {
  const settings = config.brain?.claudeCli || config;
  const env = options.env || process.env;
  offline(env);
  const executable = options.executable || await (options.resolveExecutable || resolveExecutable)('claude', options);
  if (!supportedVersion(executable.version, options.platform || process.platform)) throw new AgentProviderUnavailable('Claude CLI requires >=2.1.205 (>=2.1.211 on Windows)');
  const model = options.model || settings.model || 'claude-sonnet-5';
  // --json-schema returns the object through a tool call, so a run needs the tool-use
  // turn plus a wrap-up turn. Under --max-turns 1 the CLI reports error_max_turns with
  // stop_reason "tool_use" after the content was already produced, which surfaces as an
  // intermittent provider failure that looks like a quota problem.
  return { name: 'claude-cli', provider: 'claude-cli', model, capability: { vision: false }, async complete(request) {
    const wire = wireFor(request, 'anthropic');
    const args = [...executable.prefixArgs, '-p', '--output-format', 'json', '--json-schema', JSON.stringify(wire.schema), '--tools', '', '--max-turns', '4', '--no-session-persistence', '--strict-mcp-config', '--model', model];
    if (settings.apiKeyMode) args.push('--bare');
    const root = request.runDir || options.runDir || options.store?.root;
    const result = await (options.runProcess || runProcess)(executable.command, args, { ...options, env, input: promptText(request), timeoutMs: request.timeoutMs || 240000,
      stderrPath: root ? path.join(root, 'steps', `${request.step}-a${request.attempt || 1}.stderr.txt`) : undefined });
    if (root) await writeFileAtomic(path.join(root, 'steps', `${request.step}-a${request.attempt || 1}.claude.txt`), redact(result.stdout, env), { mode: 0o600 });
    let response;
    try { response = JSON.parse(result.stdout); } catch { throw classifyFailure(result.stdout + '\n' + result.stderr || 'Claude did not return a JSON envelope'); }
    if (response.is_error !== false || !(response.num_turns >= 1) || result.code !== 0) throw classifyFailure(JSON.stringify(response) + '\n' + result.stderr);
    if (response.stop_reason === 'max_tokens' || response.stop_reason === 'max_output_tokens') throw new AgentTruncatedError('Claude output truncated', { details: { stopReason: response.stop_reason } });
    let value = response.structured_output;
    const structured = value !== undefined && value !== null;
    if (!structured) {
      if (typeof response.result !== 'string') throw new AgentProviderError('Claude produced no structured output or result');
      value = require('./index').extractJson(response.result);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentSchemaError('Claude output is not a JSON object');
    const tokens = usage(response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null);
    if (Number.isFinite(response.total_cost_usd) && response.total_cost_usd >= 0) { tokens.costUsd = response.total_cost_usd; tokens.costSource = 'cli-estimate'; }
    return { value, provider: 'claude-cli', model, capability: { vision: false }, usage: tokens,
      wire: { dialect: 'anthropic', strict: false, structured }, stopReason: response.stop_reason || response.subtype || 'completed' };
  } };
}
module.exports = { createClaudeBrain, createClaudeCliBrain: createClaudeBrain, createBrain: createClaudeBrain, supportedVersion };
