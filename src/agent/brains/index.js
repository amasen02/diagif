'use strict';

const { validateValue, normaliseErrors } = require('./schema');
const errors = require('../errors');
const { redact } = require('../redact');

function extractJson(text) {
  if (typeof text !== 'string') throw new errors.AgentSchemaError('Expected JSON text');
  const fences = [...text.matchAll(/```json\s*\r?\n?([\s\S]*?)```/gi)];
  function object(raw) {
    let value;
    try { value = JSON.parse(raw); } catch { throw new errors.AgentSchemaError('Invalid JSON object', { details: { raw: text } }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new errors.AgentSchemaError('ambiguous JSON');
    return value;
  }
  if (fences.length) return object(fences.at(-1)[1].trim());
  const candidates = [];
  let start = -1, stack = [], quoted = false, escaped = false;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (stack.length && char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') { if (!stack.length) start = offset; stack.push(char); }
    else if (char === '}' || char === ']') {
      if (!stack.length) continue;
      const previous = stack.pop();
      if ((char === '}' && previous !== '{') || (char === ']' && previous !== '[')) { stack = []; start = -1; continue; }
      if (!stack.length && start >= 0) {
        const raw = text.slice(start, offset + 1);
        try { const value = JSON.parse(raw); if (value && typeof value === 'object' && !Array.isArray(value)) candidates.push({ value, end: offset }); } catch {}
        start = -1;
      }
    }
  }
  if (!candidates.length) throw new errors.AgentSchemaError('No complete JSON object found', { details: { raw: text } });
  const last = candidates.at(-1);
  if (candidates.filter(item => item.end === last.end).length !== 1) throw new errors.AgentSchemaError('ambiguous JSON');
  return last.value;
}

async function selectBrain(name, config = {}, options = {}) {
  if (name && typeof name === 'object') { options = config; config = name; name = options.brain; }
  const env = options.env || process.env;
  const selected = name || config.brain?.provider;
  async function create(provider) {
    if (provider === 'mock' || provider.startsWith('mock:')) return require('./mock').createMockBrain(provider.split(':')[1] || 'happy');
    if (env.DIAGIF_OFFLINE === '1') throw new errors.AgentOfflineError('Offline mode requires a mock brain');
    if (provider === 'openai') return require('./openai').createOpenAIBrain(config, options);
    if (provider === 'anthropic') return require('./anthropic').createAnthropicBrain(config, options);
    if (provider === 'codex-cli') return require('./codex-cli').createCodexBrain(config, options);
    if (provider === 'claude-cli') return require('./claude-cli').createClaudeBrain(config, options);
    throw new errors.AgentUsageError('Unknown brain: ' + provider);
  }
  if (selected) return create(selected);
  if (env.DIAGIF_OFFLINE === '1') throw new errors.AgentOfflineError('Select --brain mock for offline operation');
  if (env.OPENAI_API_KEY) return create('openai');
  if (env.ANTHROPIC_API_KEY) return create('anthropic');
  for (const provider of ['codex-cli', 'claude-cli']) {
    try { return await create(provider); } catch (error) { if (!(error instanceof errors.AgentProviderUnavailable)) throw error; }
  }
  throw new errors.AgentProviderUnavailable('Configure OPENAI_API_KEY or ANTHROPIC_API_KEY with an explicit model; install codex/claude, set DIAGIF_CODEX/DIAGIF_CLAUDE, or select --brain mock');
}

function createBrainRunner(brain, { run, store, config = {}, persist, aggregateBudget, env = process.env } = {}) {
  if (!run?.budget) throw new errors.AgentUsageError('A durable run and budget are required for model calls');
  const save = persist || (store && (() => store.persist(run)));
  if (!save) throw new errors.AgentUsageError('A run persistence callback is required for model calls');
  const defaults = require('../fixtures/config-defaults.json').limits;
  const limits = { ...defaults, ...config.limits, modelTimeoutMs: { ...defaults.modelTimeoutMs, ...config.limits?.modelTimeoutMs }, maxOutputTokens: { ...defaults.maxOutputTokens, ...config.limits?.maxOutputTokens } };
  const counts = new Map();
  return { name: brain.name, provider: brain.provider, model: brain.model, capability: brain.capability, async complete(request) {
    const step = request.step;
    if (!Object.hasOwn(defaults.maxOutputTokens, step)) throw new errors.AgentUsageError('Unknown model step: ' + step);
    let maxOutputTokens = request.maxOutputTokens || limits.maxOutputTokens[step];
    let truncated = false;
    const messages = structuredClone(request.messages || []);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (run.budget.modelCallsUsed >= run.budget.maxModelCalls || (aggregateBudget && aggregateBudget.modelCallsUsed >= aggregateBudget.maxModelCalls)) throw new errors.AgentBudgetExhausted('Model call budget exhausted');
      run.budget.modelCallsUsed++;
      if (aggregateBudget) aggregateBudget.modelCallsUsed++;
      const ordinal = (counts.get(step) || run.modelCalls.filter(call => call.step === step).length) + 1;
      counts.set(step, ordinal);
      const record = { step, attempt: ordinal, provider: brain.provider || brain.name, model: brain.model, wireDialect: 'none', wireStrict: false, structured: false,
        startedAt: new Date().toISOString(), durationMs: 0, inputTokens: brain.provider === 'mock' ? 0 : null, outputTokens: brain.provider === 'mock' ? 0 : null,
        costUsd: brain.provider === 'mock' ? 0 : null, costSource: 'none', schemaValid: false };
      run.modelCalls.push(record);
      await save(run); // Durable accounting must precede even a failed request.
      const began = performance.now();
      let result, postValidationFailed = false;
      try {
        result = await brain.complete({ ...request, messages: structuredClone(messages), attempt: ordinal, maxOutputTokens,
          timeoutMs: (request.timeoutMs || limits.modelTimeoutMs[step]) + ((brain.provider || brain.name).endsWith('-cli') ? limits.cliStartupGraceMs : 0), runDir: store?.root || request.runDir });
        Object.assign(record, { wireDialect: result.wire?.dialect || 'none', wireStrict: result.wire?.strict === true, structured: result.wire?.structured === true,
          ...(result.usage || {}), ...(result.stopReason ? { stopReason: result.stopReason } : {}) });
        // Persist the original response, including invalid attempts, without request bodies.
        if (store) await store.writeJson(`steps/${step}-a${ordinal}.response.json`, result.value);
        let schemaValid = true;
        try { validateValue(request.schema, result.value); }
        catch (error) {
          // The harness owns deterministic scene repair. A complete envelope
          // with scene validation errors must reach it before another model call.
          const sceneErrors = error instanceof errors.AgentSchemaError && Array.isArray(error.details)
            && error.details.length && error.details.every(detail => detail.path === '/scene' || detail.path.startsWith('/scene/'));
          if (step !== 'scene' || !request.deferSceneValidation || !sceneErrors || !result.value?.scene
            || typeof result.value.scene !== 'object' || Array.isArray(result.value.scene)) throw error;
          schemaValid = false;
        }
        if (step === 'scene') {
          const scene = result.value.scene;
          if (scene.brand !== undefined) throw new errors.AgentSchemaError('Scene proposals must omit brand', { details: [{ path: '/scene/brand', message: 'must be absent' }] });
          if (request.format === 'mindmap' && (scene.layout?.kind !== 'mindmap' || scene.nodes.length || scene.edges.length || scene.timeline.animations.length)) throw new errors.AgentSchemaError('Mindmap proposals must have empty generated arrays');
          if (request.format && request.format !== 'mindmap' && scene.layout?.kind === 'mindmap') throw new errors.AgentSchemaError('Normal briefs must not produce mindmaps');
        }
        if (request.postValidate) {
          try { await request.postValidate(result.value); }
          catch (error) { postValidationFailed = true; throw error; }
        }
        record.schemaValid = schemaValid;
        record.durationMs = performance.now() - began;
        await save(run);
        return result;
      } catch (caught) {
        const error = caught instanceof errors.AgentError ? caught : new errors.AgentProviderError(caught.message || String(caught), { cause: caught });
        record.durationMs = performance.now() - began;
        record.error = redact(errors.toSafeJson(error), env);
        if (error.details?.stopReason) record.stopReason = error.details.stopReason;
        if (store && error.details?.raw !== undefined) await store.writeJson(`steps/${step}-a${ordinal}.response.json`, error.details.raw);
        await save(run);
        if (attempt === 3) throw error;
        if (error instanceof errors.AgentTruncatedError) {
          if (truncated) throw error;
          truncated = true; maxOutputTokens *= 2;
        } else if (step === 'research' && postValidationFailed && error instanceof errors.AgentResearchInsufficient) {
          // Grounding is an output-validation gate. Correct the fact sheet
          // against the same extracts within the existing three-call budget;
          // collection failures and provider failures are never retried here.
          messages.push({ role: 'user', content: JSON.stringify(redact({ previousFactSheet: result.value,
            errors: error.details || [{ path: '/facts', message: error.message }] }, env))
            + '\nReturn the complete corrected fact sheet. Copy each quote directly from its cited supplied extract, including spaces before punctuation. Do not paraphrase quotes or change source metadata. Every fact must pass the unchanged exact grounding check.' });
        } else if (error instanceof errors.AgentSchemaError) {
          const detail = Array.isArray(error.details) ? error.details : [{ path: '/', message: error.message }];
          messages.push({ role: 'user', content: JSON.stringify(redact(detail, env)) + '\nreturn the complete corrected JSON object' });
        } else if (!error.retryable) throw error;
      }
    }
  } };
}
async function complete(request, context) { return createBrainRunner(context.brain, context).complete(request); }
module.exports = { selectBrain, createBrainRunner, wrapBrain: createBrainRunner, complete, extractJson, validateValue, normaliseErrors };
