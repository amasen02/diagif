#!/usr/bin/env node
'use strict';

const { parseArgs, HELP } = require('../src/agent/cli-args.js');
const { exitCodeFor, toSafeJson } = require('../src/agent/errors.js');

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const log = dependencies.log || console.log, errorLog = dependencies.error || console.error;
  try {
    const { command, topic, options } = parseArgs(argv);
    if (command === 'help') { log(HELP); return 0; }
    if (command === 'version') { log(require('../package.json').version); return 0; }
    if (command === 'brand') {
      const config = dependencies.config || require('../src/agent/config.js');
      const loaded = await config.loadConfig(options.config);
      const file = loaded.configPath || require('node:path').join(loaded.configDir, 'diagif.config.json');
      if (options.clear) delete loaded.brand;
      else loaded.brand = { style: 'url-footer', url: config.canonicalizeBrandUrl(options.url) };
      await config.saveConfig(file, loaded); log('Brand configuration saved: ' + file); return 0;
    }
    if (command === 'doctor') {
      if (dependencies.doctor) { await dependencies.doctor(options); return 0; }
      const { loadConfig } = require('../src/agent/config.js'), { resolveExecutable } = require('../src/agent/exec-resolve.js');
      const cfg = loadConfig(options.config);
      log('Research providers: ' + cfg.research.providers.join(', '));
      for (const [provider, env] of [['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']]) log(provider + ': ' + (process.env[env] ? 'credential configured' : 'not configured'));
      for (const name of ['codex', 'claude']) {
        try { const executable = await resolveExecutable(name); log(name + ': ' + executable.version); }
        catch (error) { log(name + ': ' + toSafeJson(error).message); }
      }
      log('mock: available'); return 0;
    }
    const harness = dependencies.harness || require('../src/agent/harness.js');
    const result = command === 'scout' ? await harness.runScout({ ...options, log }) : command === 'mindmap'
      ? await harness.runMindmap(topic, options) : await harness.runMake(topic, options);
    log(result.run.status + ': ' + result.runDir); return result.exitCode || 0;
  } catch (error) {
    const safe = toSafeJson(error); errorLog(safe.code + ': ' + safe.message);
    if (safe.details) errorLog(JSON.stringify(safe.details));
    return exitCodeFor(error);
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main };
