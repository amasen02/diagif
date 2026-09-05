'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { rootPath } = require('../paths.js');
const { runProcess, resolvePython } = require('../python.js');
function resolveExecutable(command) {
  const directories = command.includes('/') || command.includes('\\') ? [''] : (process.env.PATH || '').split(path.delimiter);
  const suffixes = process.platform === 'win32' && !path.extname(command) ? ['', '.exe'] : [''];
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = path.resolve(directory, command + suffix);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && !/\.(cmd|bat)$/i.test(candidate)) return candidate;
  }
  return null;
}
async function discover() {
  for (const candidate of (process.env.TECH_GIFS_GIFSKI ? [process.env.TECH_GIFS_GIFSKI] : [rootPath('tools/bin/gifski' + (process.platform === 'win32' ? '.exe' : '')), 'gifski'])) {
    try {
      const command = resolveExecutable(candidate);
      if (!command) continue;
      const version = await runProcess(command, ['--version'], { timeout: 15000 });
      const help = await runProcess(command, ['--help'], { timeout: 15000 });
      if (version.code || help.code) continue;
      const text = help.stdout + help.stderr;
      return { command, path: command, version: version.stdout.trim(), capabilities: { noSort: text.includes('--no-sort'), fixedColor: text.includes('--fixed-color') } };
    } catch { /* Optional executable: try the next discovery location. */ }
  }
  return null;
}
function buildArgv({ fps = 25, width = 800, quality = 80, motionQuality = 90, lossyQuality = 90, outPath, framePaths, fixedColors = [], expectedFrames = framePaths?.length, capabilities = { noSort: true, fixedColor: true } }) {
  if (!Array.isArray(framePaths) || !framePaths.length || framePaths.length !== expectedFrames) throw new Error('framePaths length must equal expectedFrames');
  if (framePaths.some(p => !path.isAbsolute(p) || /[*?\[\]]/.test(p))) throw new Error('Frames must be explicit absolute paths, without glob characters');
  const ordered = [...framePaths].sort((a, b) => Number(path.basename(a).match(/(\d+)\.png$/)?.[1]) - Number(path.basename(b).match(/(\d+)\.png$/)?.[1]));
  if (fixedColors.some(c => !/^#[\da-f]{6}$/i.test(c))) throw new Error('fixedColors must be #RRGGBB');
  return ['--fps', String(fps), '--width', String(width), '-Q', String(quality), '--motion-quality', String(motionQuality), '--lossy-quality', String(lossyQuality), '--repeat', '0',
    ...(capabilities.noSort ? ['--no-sort'] : []), ...(capabilities.fixedColor ? fixedColors.flatMap(c => ['--fixed-color', c.slice(1)]) : []), '-o', path.resolve(outPath), ...ordered];
}
async function encode(options) {
  const tool = options.tool || await discover();
  if (!tool) throw new Error('gifski unavailable; use --encoder pillow or run node scripts/fetch-tools.js');
  const capabilities = { ...tool.capabilities }, droppedFlags = [];
  for (const [key, flag] of [['noSort', '--no-sort'], ['fixedColor', '--fixed-color']]) if (!capabilities[key]) droppedFlags.push(flag);
  let argv, result;
  for (let attempt = 0; attempt < 3; attempt++) {
    argv = buildArgv({ ...options, capabilities });
    result = await runProcess(tool.command, argv);
    if (result.code === 0) break;
    const message = result.stdout + result.stderr;
    const rejected = [['noSort', '--no-sort'], ['fixedColor', '--fixed-color']].find(([key, flag]) => capabilities[key] && message.includes(flag) && /unexpected|unknown|unrecognized|invalid option/i.test(message));
    if (!rejected) break;
    capabilities[rejected[0]] = false; droppedFlags.push(rejected[1]);
  }
  const logPath = options.logPath || options.outPath + '.encode.log';
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify({ tool, argv, capabilities, droppedFlags }) + '\n' + result.stdout + result.stderr);
  if (result.code !== 0) throw new Error(`gifski exit ${result.code}: ${result.stderr || result.stdout}`);
  const python = await resolvePython();
  const stabilizationJob = options.outPath + '.stabilization-job.json';
  fs.writeFileSync(stabilizationJob, JSON.stringify({ mode: 'stabilize', gifPath: path.resolve(options.outPath), framePaths: options.framePaths,
    stepMs: options.stepMs || 1000 / (options.fps || 25), reservedColors: options.fixedColors || [], force: !!options.compareStabilized }));
  const stabilized = await runProcess(python.command, [path.join(__dirname, 'pillow.py'), '--job', stabilizationJob]);
  fs.appendFileSync(logPath, '\nStatic stabilization:\n' + stabilized.stdout + stabilized.stderr);
  if (stabilized.code !== 0) throw new Error(`gifski static stabilization exit ${stabilized.code}: ${stabilized.stderr}`);
  const postprocess = JSON.parse(stabilized.stdout.trim());
  return { gifPath: path.resolve(options.outPath), encoder: 'gifski', bytes: fs.statSync(options.outPath).size, argv, tool: { ...tool, capabilities, droppedFlags }, droppedFlags, postprocess,
    warnings: postprocess.applied ? [postprocess.nativeFlickerPixels ? 'Native gifski static shimmer repaired with a Pillow shared-palette pass; native GIF retained' : 'Pillow shared-palette comparison generated; native GIF retained and preferred when passing'] : [], logPath };
}
module.exports = { discover, buildArgv, encode, resolveExecutable };
