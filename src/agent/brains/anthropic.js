'use strict';

const { AgentProviderUnavailable, AgentTruncatedError, AgentProviderError, AgentRefusalError, AgentSchemaError } = require('../errors');
const { wireFor, usage, postJson, imageData, endpoint } = require('./common');
function createAnthropicBrain(config = {}, options = {}) {
  const settings = config.brain?.anthropic || config;
  const env = options.env || process.env;
  const model = options.model || settings.model;
  if (!model) throw new AgentProviderUnavailable('Anthropic requires an explicit model in config.brain.anthropic.model or --model');
  if (!env.ANTHROPIC_API_KEY) throw new AgentProviderUnavailable('Set ANTHROPIC_API_KEY to use the Anthropic provider');
  return { name: 'anthropic', provider: 'anthropic', model, capability: { vision: true }, async complete(request) {
    const wire = wireFor(request, 'anthropic');
    const messages = (request.messages || []).map(message => ({ role: message.role, content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : structuredClone(message.content) }));
    if (request.images?.length) {
      let final = messages.at(-1);
      if (final?.role !== 'user') { final = { role: 'user', content: [] }; messages.push(final); }
      for (const image of request.images) final.content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: await imageData(image) } });
    }
    const body = { model, max_tokens: request.maxOutputTokens || 3000, system: request.system || '', messages };
    if (request.step === 'scene') body.system += '\nOriginal acceptance schema: ' + JSON.stringify(request.schema);
    if (settings.legacyToolMode) {
      body.tools = [{ name: 'emit_json', description: 'Emit the complete structured answer', strict: true, input_schema: wire.schema }];
      body.tool_choice = { type: 'auto' };
      body.system += '\nUse emit_json to return the structured answer.';
    } else body.output_config = { format: { type: 'json_schema', schema: wire.schema } };
    let response;
    try { response = await postJson(endpoint(settings.baseUrl || 'https://api.anthropic.com', '/v1/messages'), { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, body, { ...options, env, timeoutMs: request.timeoutMs }); }
    catch (error) { if (/forced tool use/i.test(error.message)) throw new AgentProviderError(model + ': ' + error.message); throw error; }
    if (response.stop_reason === 'max_tokens') throw new AgentTruncatedError('Anthropic output truncated', { details: { stopReason: 'max_tokens' } });
    if (response.stop_reason === 'refusal' || response.content?.some(part => part.type === 'refusal')) throw new AgentRefusalError('Anthropic refused the request');
    const tool = settings.legacyToolMode && response.content?.filter(part => part.type === 'tool_use' && part.name === 'emit_json');
    if (response.stop_reason !== 'end_turn' && !(tool?.length === 1 && response.stop_reason === 'tool_use')) throw new AgentProviderError('Anthropic response did not end normally: ' + response.stop_reason);
    let value;
    if (tool?.length === 1) value = tool[0].input;
    else {
      const blocks = (response.content || []).filter(part => part.type === 'text');
      if (blocks.length !== 1) throw new AgentSchemaError('Anthropic must return one JSON text block', { details: { raw: response.content } });
      try { value = JSON.parse(blocks[0].text); } catch { throw new AgentSchemaError('Anthropic returned invalid JSON', { details: { raw: blocks[0].text } }); }
    }
    return { value, usage: usage(response.usage?.input_tokens ?? null, response.usage?.output_tokens ?? null, settings.pricePer1MTokens), provider: 'anthropic', model,
      capability: { vision: true }, wire: { dialect: 'anthropic', strict: false, structured: true }, stopReason: response.stop_reason };
  } };
}
module.exports = { createAnthropicBrain, createBrain: createAnthropicBrain };
