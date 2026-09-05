'use strict';
const { spawn } = require('node:child_process');
function runProcess(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout?.on('data', b => { stdout += b; });
    child.stderr?.on('data', b => { stderr += b; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function pythonCandidates(platform = process.platform, env = process.env) {
  return [...(env.TECH_GIFS_PYTHON ? [{ command: env.TECH_GIFS_PYTHON, args: [] }] : []),
    ...(platform === 'win32' ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }] : [{ command: 'python3', args: [] }])]
    .filter(c => platform !== 'win32' || !/(?:^|[\\/])python3(?:\.exe)?$/i.test(c.command));
}
async function resolvePython(options = {}) {
  const failures = [];
  for (const candidate of pythonCandidates(options.platform, options.env)) {
    try {
      const result = await runProcess(candidate.command, [...candidate.args, '-c', 'import sys,json,PIL; print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"pillowVersion":PIL.__version__}))'], { timeout: 15000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'probe exit ' + result.code);
      const probe = JSON.parse(result.stdout.trim());
      if (parseInt(probe.pillowVersion, 10) < 10) throw new Error('Pillow >=10 required');
      return { command: probe.executable, executable: probe.executable, args: [], version: probe.version, pillowVersion: probe.pillowVersion, discoveredVia: candidate.command };
    } catch (error) { failures.push(candidate.command + ': ' + error.message); }
  }
  throw new Error('Python with Pillow >=10 not found. Install requirements.txt. ' + failures.join('; '));
}
module.exports = { resolvePython, pythonCandidates, runProcess };
