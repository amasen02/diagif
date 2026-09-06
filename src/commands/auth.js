'use strict';

const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const { resolveExecutable } = require('../agent/exec-resolve');
const { AgentProviderUnavailable } = require('../agent/errors');
const { loginArgs, getAuthStatuses, formatStatus } = require('../agent/auth');

async function run(options = {}, dependencies = {}) {
  const log = dependencies.log || console.log;
  if (options.login) {
    const args = loginArgs(options.login);
    const executable = await (dependencies.resolveExecutable || resolveExecutable)(options.login, dependencies);
    if (/\.(cmd|bat|ps1)$/i.test(executable.command)) throw new AgentProviderUnavailable('Login requires a real executable or Node JS entrypoint');
    const argv = [...executable.prefixArgs, ...args];
    if (options.dryRun) {
      log(JSON.stringify({ command: executable.command, args: argv, shell: false, stdio: 'inherit' }, null, 2));
      return 0;
    }
    return new Promise((resolve, reject) => {
      let child;
      try { child = (dependencies.spawn || spawn)(executable.command, argv, {
        shell: false, stdio: 'inherit', cwd: dependencies.cwd, env: dependencies.env || process.env
      }); } catch { reject(new AgentProviderUnavailable('Cannot start login; run diagif auth')); return; }
      child.once('error', () => reject(new AgentProviderUnavailable('Cannot start login; run diagif auth')));
      child.once('close', (code, signal) => resolve(code ?? (128 + (constants.signals[signal] || 1))));
    });
  }
  const statuses = await (dependencies.getAuthStatuses || getAuthStatuses)(dependencies);
  if (options.json) log(JSON.stringify(statuses, null, 2));
  else statuses.forEach(row => log(formatStatus(row)));
  return 0;
}
module.exports = { run };
