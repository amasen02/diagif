'use strict';

const { AgentProviderUnavailable, AgentTruncatedError, AgentProviderError, AgentRefusalError, AgentSchemaError } = require('../errors');
const { wireFor, usage, postJson, imageData, endpoint } = require('./common');
function createOpenAIBrain(config = {}, options = {}) {
  const settings = config.brain?.openai || config;
  const env = options.env || process.env;
  const model = options.model || settings.model;
  if (!model) throw new AgentProviderUnavailable('OpenAI requires an explicit model in config.brain.openai.model or --model');
  if (!env.OPENAI_API_KEY) throw new AgentProviderUnavailable('Set OPENAI_API_KEY to use the OpenAI provider');
  return { name: 'openai', provider: 'openai', model, capability: { vision: true }, async complete(request) {
    const wire = wireFor(request, 'openai-strict');
    const input = [{ role: 'system', content: [{ type: 'input_text', text: request.system || '' }] }, ...(request.messages || []).map(message => ({
      role: message.role, content: typeof message.content === 'string' ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] : structuredClone(message.content)
    }))];
    if (request.step === 'scene') input[0].content[0].text += '\nOriginal acceptance schema: ' + JSON.stringify(request.schema);
    if (request.images?.length) {
      let final = input.at(-1);
      if (final.role !== 'user') { final = { role: 'user', content: [] }; input.push(final); }
      for (const image of request.images) final.content.push({ type: 'input_image', image_url: 'data:image/png;base64,' + await imageData(image) });
    }
    const body = { model, store: false, input, text: { format: { type: 'json_schema', name: 'diagif_step', strict: wire.strict, schema: wire.schema } }, max_output_tokens: request.maxOutputTokens || 3000 };
    if (settings.reasoningEffort) body.reasoning = { effort: settings.reasoningEffort };
    const response = await postJson(endpoint(settings.baseUrl || 'https://api.openai.com', '/v1/responses'), { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' }, body, { ...options, env, timeoutMs: request.timeoutMs });
    const parts = (response.output || []).flatMap(item => item.content || []);
    if (parts.some(part => part.type === 'refusal')) throw new AgentRefusalError('OpenAI refused the request');
    if (response.status !== 'completed') {
      const reason = response.incomplete_details?.reason || response.status || 'missing status';
      if (reason === 'max_output_tokens') throw new AgentTruncatedError('OpenAI output truncated', { details: { stopReason: reason } });
      throw new AgentProviderError('OpenAI response was not completed: ' + reason);
    }
    const raw = parts.filter(part => part.type === 'output_text').map(part => part.text).join('');
    let value;
    try { value = JSON.parse(raw); } catch { throw new AgentSchemaError('OpenAI returned invalid JSON', { details: { raw } }); }
    return { value, usage: usage(response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null, settings.pricePer1MTokens), provider: 'openai', model,
      capability: { vision: true }, wire: { dialect: wire.dialect, strict: wire.strict, structured: true }, stopReason: response.status };
  } };
}
module.exports = { createOpenAIBrain, createBrain: createOpenAIBrain };
