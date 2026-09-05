'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { resolveExecutable } = require('../exec-resolve');
const { writeFileAtomic } = require('../../fs-atomic');
const { redact } = require('../redact');
const { AgentProviderError, AgentTruncatedError, AgentUsageError } = require('../errors');
const { wireFor, usage, offline, classifyFailure, promptText, runProcess } = require('./common');
async function createCodexBrain(config = {}, options = {}) {
  const settings = config.brain?.codex || config;
  const env = options.env || process.env;
  offline(env);
  const executable = options.executable || await (options.resolveExecutable || resolveExecutable)('codex', options);
  const model = options.model || settings.model || 'gpt-5.6-luna';
  const run = options.runProcess || runProcess;
  let vision = executable.vision === true;
  if (executable.vision === undefined) {
    const probe = await run(executable.command, [...executable.prefixArgs, 'exec', '--help'], { ...options, env, timeoutMs: 15000 });
    vision = probe.code === 0 && /(?:^|\s)-i(?:,|\s).*--image/m.test(probe.stdout);
  }
  return { name: 'codex-cli', provider: 'codex-cli', model, capability: { vision }, async complete(request) {
    offline(env);
    const root = request.runDir || options.runDir || options.store?.root;
    if (!root) throw new AgentUsageError('codex-cli requires a runDir for durable result artifacts');
    const attempt = request.attempt || 1;
    if (!/^[a-z0-9-]+$/i.test(request.step) || !Number.isInteger(attempt) || attempt < 1) throw new AgentUsageError('Invalid model step or attempt');
    const resultPath = path.join(root, 'steps', `${request.step}-a${attempt}.codex.txt`);
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.rm(resultPath, { force: true });
    const args = [...executable.prefixArgs, 'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--color', 'never', '--json', '-m', model, '-o', resultPath, '-', '-c', 'model_reasoning_effort=' + (settings.reasoningEffort || 'medium')];
    if (request.step !== 'scene') {
      const schema = JSON.stringify(wireFor(request, 'openai-strict').schema);
      const schemaPath = path.join(root, 'internal', 'schema-' + createHash('sha256').update(schema).digest('hex') + '.json');
      await writeFileAtomic(schemaPath, schema + '\n');
      args.push('--output-schema', schemaPath);
    }
    if (vision) for (const image of request.images || []) args.push('-i', typeof image === 'string' ? image : image.path);
    args.push(...(settings.extraArgs || []));
    const result = await run(executable.command, args, { ...options, env, input: promptText(request), timeoutMs: request.timeoutMs || 240000,
      stderrPath: path.join(root, 'steps', `${request.step}-a${attempt}.stderr.txt`) });
    let raw = '';
    try { raw = await fs.readFile(resultPath, 'utf8'); await writeFileAtomic(resultPath, redact(raw, env), { mode: 0o600 }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const diagnostics = result.stdout + '\n' + result.stderr;
    if (/You've hit your usage limit/i.test(diagnostics)) throw classifyFailure(diagnostics);
    if (result.code !== 0) throw classifyFailure(diagnostics.trim() || 'Codex exited ' + result.code);
    let tokens;
    for (const line of result.stdout.split(/\r?\n/)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (['error', 'turn.failed', 'thread.error'].includes(event.type)) throw classifyFailure(JSON.stringify(event));
      if (event.type === 'turn.completed') tokens = event.usage;
    }
    if (!raw.trim()) throw classifyFailure(diagnostics.trim() || 'Codex produced no result artifact');
    let value;
    try { value = require('./index').extractJson(raw); }
    catch (error) { if (/max_output_tokens/.test(diagnostics)) throw new AgentTruncatedError('Codex output truncated', { details: { stopReason: 'max_output_tokens' } }); throw error; }
    return { value, provider: 'codex-cli', model, capability: { vision }, usage: usage(tokens?.input_tokens ?? null, tokens?.output_tokens ?? null),
      wire: { dialect: request.step === 'scene' ? 'none' : 'openai-strict', strict: request.step !== 'scene', structured: request.step !== 'scene' }, stopReason: 'completed' };
  } };
}
module.exports = { createCodexBrain, createCodexCliBrain: createCodexBrain, createBrain: createCodexBrain };
