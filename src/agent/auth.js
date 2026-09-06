'use strict';

const { spawnSync } = require('node:child_process');
const { resolveExecutable } = require('./exec-resolve');
const { AgentProviderUnavailable, AgentUsageError } = require('./errors');

const cli = {
  codex: { status: ['login', 'status'], login: ['login'], install: 'npm i -g @openai/codex' },
  claude: { status: ['auth', 'status', '--json'], login: ['auth', 'login', '--claudeai'], install: 'npm i -g @anthropic-ai/claude-code' }
};
function loginArgs(provider) {
  if (!Object.hasOwn(cli, provider)) throw new AgentUsageError('--login must be codex or claude');
  return [...cli[provider].login];
}
function parseStatus(provider, result) {
  if (result.error || result.signal) return { status: 'unknown' };
  const code = result.status ?? result.code;
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  if (provider === 'codex') {
    if (code === 0 && /Logged in using ChatGPT/i.test(output)) return { status: 'authenticated', accountType: 'ChatGPT' };
    if (code === 0 && /Logged in using (?:an? )?API key/i.test(output)) return { status: 'authenticated', accountType: 'API key' };
    if (/^\s*Not logged in\s*$/im.test(output)) return { status: 'not-logged-in' };
  } else {
    try {
      const value = JSON.parse(result.stdout);
      if (value.loggedIn === false) return { status: 'not-logged-in' };
      if (code === 0 && value.loggedIn === true) {
        // Allowlist labels only: never expose account identifiers or raw diagnostics.
        const accountType = value.authMethod === 'oauth' || ['pro', 'max', 'team', 'enterprise'].includes(value.subscriptionType)
          ? 'Claude subscription' : value.authMethod === 'api_key' ? 'API key' : 'Claude account';
        return { status: 'authenticated', accountType };
      }
    } catch {}
  }
  return { status: 'unknown' };
}
async function probeCliAuth(provider, options = {}) {
  loginArgs(provider);
  const fix = 'diagif auth --login ' + provider;
  let executable;
  try { executable = options.executable || await (options.resolveExecutable || resolveExecutable)(provider, options); }
  catch (error) {
    if (!(error instanceof AgentProviderUnavailable)) throw error;
    return { provider, status: 'unavailable', executable: null, version: null, fix: cli[provider].install + ' ; ' + fix };
  }
  let result;
  try {
    result = await (options.statusProbe || spawnSync)(executable.command, [...executable.prefixArgs, ...cli[provider].status], {
      cwd: options.cwd, env: options.env || process.env, shell: false, windowsHide: true,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, maxBuffer: 1024 * 1024
    });
  } catch { result = { error: true }; }
  const state = parseStatus(provider, result);
  return { provider, ...state, executable: executable.path || executable.command, version: executable.version,
    ...(state.status === 'authenticated' ? {} : { fix }) };
}
async function getAuthStatuses(options = {}) {
  const env = options.env || process.env;
  const api = [['openai', 'OPENAI_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']].map(([provider, variable]) => ({
    provider, status: env[variable] ? 'configured' : 'not-configured', variable,
    ...(env[variable] ? {} : { fix: (options.platform || process.platform) === 'win32' ? `$env:${variable} = '<your API key>'` : `export ${variable}='<your API key>'` })
  }));
  return [...api, ...await Promise.all(['codex', 'claude'].map(name => probeCliAuth(name, options))),
    { provider: 'mock', status: 'available', detail: 'offline, no credentials' }];
}
function formatStatus(row) {
  return row.provider + ': ' + row.status + (row.accountType ? ' (' + row.accountType + ')' : '')
    + (row.detail ? ' (' + row.detail + ')' : '') + (row.version ? ' | ' + row.version : '')
    + (row.executable ? ' | ' + row.executable : '') + (row.fix ? ' | run: ' + row.fix : '');
}
module.exports = { loginArgs, parseStatus, probeCliAuth, getAuthStatuses, formatStatus };
