'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildArgv } = require('../src/encode/gifski.js');
const { pythonCandidates, resolvePython, runProcess } = require('../src/python.js');
const { encode, runLadder, listFrames } = require('../src/encode/encode.js');
const { verify, assertDelays } = require('../src/quality/quality-gate.js');
const defaults = require('../config/defaults.json');
const root = path.resolve(__dirname, '..');
function workspace() {
  fs.mkdirSync(path.join(root, 'work', 'encode-tests'), { recursive: true });
  return fs.mkdtempSync(path.join(root, 'work', 'encode-tests', 'run-'));
}
function localPaletteCount(file) {
  const data = fs.readFileSync(file);
  let offset = 13 + (data[10] & 128 ? 3 * (2 << (data[10] & 7)) : 0), count = 0;
  const skipBlocks = () => { while (data[offset]) offset += data[offset] + 1; offset++; };
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3B) break;
    if (marker === 0x21) { offset++; skipBlocks(); }
    else if (marker === 0x2C) {
      const packed = data[offset + 8]; offset += 9;
      if (packed & 128) { count++; offset += 3 * (2 << (packed & 7)); }
      offset++; skipBlocks();
    } else throw new Error('Invalid GIF block ' + marker);
  }
  return count;
}

test('gifski rung 0 argv uses loop forever, no-sort, explicit numerically ordered paths and Q <=80', () => {
  const paths = [10, 2, 0].map(i => path.join(root, 'work', 'with spaces', `frame_${String(i).padStart(4, '0')}.png`));
  const argv = buildArgv({ ...defaults.ladder[0], outPath: path.join(root, 'work', 'out with spaces.gif'), framePaths: paths, expectedFrames: 3, fixedColors: ['#FB923C'] });
  assert.equal(argv[argv.indexOf('--repeat') + 1], '0');
  assert.ok(argv.includes('--no-sort'));
  assert.ok(Number(argv[argv.indexOf('-Q') + 1]) <= 80);
  assert.ok(argv.every(arg => !/[*?\[\]]/.test(arg)));
  assert.deepEqual(argv.slice(-3), [paths[2], paths[1], paths[0]]);
  assert.equal(argv[argv.indexOf('--fixed-color') + 1], 'FB923C');
  assert.throws(() => buildArgv({ framePaths: paths, expectedFrames: 4, outPath: 'out.gif' }), /expectedFrames/);
  assert.throws(() => buildArgv({ framePaths: ['*.png'], outPath: 'out.gif' }), /explicit absolute/);
  const compatible = buildArgv({ framePaths: paths, outPath: 'out.gif', fixedColors: ['#FB923C'], capabilities: { fixedColor: false, noSort: false } });
  assert.ok(!compatible.includes('--fixed-color') && !compatible.includes('--no-sort'));
});

test('Windows Python candidates and resolved interpreter never use the python3 Store stub', async () => {
  for (const override of ['python3', 'C:\\WindowsApps\\python3.exe']) { // sanitize-allow: Windows Store path fixture
    const candidates = pythonCandidates('win32', { TECH_GIFS_PYTHON: override });
    assert.deepEqual(candidates.map(c => c.command), ['py', 'python']);
    assert.deepEqual(candidates[0].args, ['-3']);
  }
  const python = await resolvePython();
  if (process.platform === 'win32') assert.doesNotMatch(python.command, /(?:^|[\\/])python3(?:\.exe)?$/i);
  assert.ok(Number(python.pillowVersion.split('.')[0]) >= 10);
});

test('merged delays are accepted; bad grids, sums, strict counts and limits fail in JS and Python', async () => {
  assert.equal(assertDelays([40, 40, 80, 40], 200, 40), true);
  assert.throws(() => assertDelays([40, 50], 200, 40));
  assert.throws(() => assertDelays([40, 40], 200, 40), /sum/);
  assert.throws(() => assertDelays([40, 40, 80, 40], 200, 40, true), /strict/);
  assert.throws(() => assertDelays(Array(251).fill(40), 10040, 40), /frame count/);
  const python = await resolvePython();
  const result = await runProcess(python.command, ['-B', '-c',
    'import importlib.util,sys; s=importlib.util.spec_from_file_location("gate",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert not m.delay_failures([40,40,80,40],200,40); assert m.delay_failures([40,50],200,40); assert m.delay_failures([40,40],200,40); print("Python timing assertions passed")', path.join(root, 'src/quality/verify.py')]);
  assert.equal(result.code, 0, result.stderr);
});

test('real Pillow shared palette, merged frames and gate negative controls', async () => {
  const dir = workspace(), framesDir = path.join(dir, 'frames-40');
  const python = await resolvePython();
  const generated = await runProcess(python.command, ['-c',
    'from pathlib import Path; from PIL import Image,ImageDraw; import sys,shutil\np=Path(sys.argv[1]); p.mkdir()\nfor i,x in enumerate([10,20,20,30,40]):\n im=Image.new("RGB",(160,200),"#123456"); d=ImageDraw.Draw(im); d.rectangle((x,100,x+20,130),fill="#FB923C"); d.rectangle((10,10,145,30),fill="#FFFFFF"); im.save(p/f"frame_{i:04d}.png")\nshutil.copyfile(p/"frame_0000.png",p/"seam.png")', framesDir]);
  assert.equal(generated.code, 0, generated.stderr);
  const encoded = await encode({ framesDir, outPath: path.join(dir, 'good.gif'), durationMs: 200, stepMs: 40, encoder: 'pillow', width: 80, reservedColors: ['#123456', '#FB923C', '#FFFFFF'] });
  const options = { gifPath: encoded.gifPath, framesDir, expectedWidth: 80, expectedHeight: 100, expectedDurationMs: 200, stepMs: 40, maxBytes: 5000000, encoder: 'pillow', reservedColors: encoded.reservedColors };
  const good = await verify(options);
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.metrics.loopSeamOk, true);
  assert.equal(good.metrics.flickerPixelCount, 0);
  assert.ok(good.metrics.mergedFrames >= 1);
  assert.ok(Object.values(good.metrics.reservedColorHits).every(n => n > 0));
  assert.equal(localPaletteCount(encoded.gifPath), 0, 'Pillow must use only the global palette');
  assert.equal(fs.readFileSync(good.metrics.contactSheet).subarray(1, 4).toString(), 'PNG');
  assert.equal((await verify({ ...options, strictFrameCount: true })).ok, false);
  assert.equal((await verify({ ...options, maxBytes: 1 })).ok, false);
  assert.equal((await verify({ ...options, reservedColors: ['#010203'] })).ok, false);
  const changed = await runProcess(python.command, ['-c',
    'from PIL import Image,ImageSequence,ImageDraw; import sys\nim=Image.open(sys.argv[1]); frames=[f.convert("RGB") for f in ImageSequence.Iterator(im)]; ImageDraw.Draw(frames[1]).rectangle((10,10,20,20),fill="#00FF00"); frames[0].save(sys.argv[2],save_all=True,append_images=frames[1:],duration=[40,80,40,40],loop=0,disposal=1)', encoded.gifPath, path.join(dir, 'flicker.gif')]);
  assert.equal(changed.code, 0, changed.stderr);
  const bad = await verify({ ...options, gifPath: path.join(dir, 'flicker.gif'), reservedColors: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.metrics.flickerPixelCount > 0, JSON.stringify(bad));
  const stabilizationJob = path.join(dir, 'stabilize.json');
  fs.writeFileSync(stabilizationJob, JSON.stringify({ mode: 'stabilize', gifPath: path.join(dir, 'flicker.gif'), framePaths: listFrames(framesDir), stepMs: 40, reservedColors: [] }));
  const stabilized = await runProcess(python.command, [path.join(root, 'src/encode/pillow.py'), '--job', stabilizationJob]);
  assert.equal(stabilized.code, 0, stabilized.stderr);
  assert.equal(JSON.parse(stabilized.stdout).applied, true);
  const repaired = await verify({ ...options, gifPath: path.join(dir, 'flicker.gif'), reservedColors: [] });
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.metrics.totalMs, 200);
  assert.equal(repaired.metrics.flickerPixelCount, 0);
  assert.ok(fs.existsSync(path.join(dir, 'flicker.gif.native.gif')));
  fs.writeFileSync(path.join(framesDir, 'seam.png'), 'not the first PNG');
  assert.equal((await verify(options)).metrics.loopSeamOk, false);
  assert.equal((await verify({ ...options, gifPath: path.join(dir, 'missing.gif') })).ok, false);
});

test('a single-frame Pillow input has a valid master palette and no sample division by zero', async () => {
  const dir = workspace(), framesDir = path.join(dir, 'frames-40');
  const python = await resolvePython();
  const result = await runProcess(python.command, ['-c', 'from PIL import Image; from pathlib import Path; import sys,shutil; p=Path(sys.argv[1]);p.mkdir();Image.new("RGB",(80,100),"#123456").save(p/"frame_0000.png");shutil.copyfile(p/"frame_0000.png",p/"seam.png")', framesDir]);
  assert.equal(result.code, 0, result.stderr);
  const output = await encode({ framesDir, outPath: path.join(dir, 'one.gif'), durationMs: 40, encoder: 'pillow', width: 80, reservedColors: ['#123456'] });
  const gate = await verify({ gifPath: output.gifPath, framesDir, expectedWidth: 80, expectedHeight: 100, expectedDurationMs: 40, stepMs: 40, maxBytes: 5000000, encoder: 'pillow', reservedColors: ['#123456'] });
  assert.equal(gate.ok, true, JSON.stringify(gate));
  assert.equal(gate.metrics.frames, 1);
});

function ladderHarness(sizes, options = {}) {
  const dir = workspace(), calls = [], captures = [];
  const scene = { id: 'test-ladder', canvas: { width: 800, height: 1000 }, grain: true, timeline: { durationMs: 4000 } };
  const stages = {
    capture: async (scene, opts) => { captures.push({ scene, ...opts }); return { framesDir: dir, framePaths: ['unused-for-injected-encoder'] }; },
    encode: async args => { calls.push(args); fs.writeFileSync(args.outPath, Buffer.alloc(sizes[args.rung.rung])); return { gifPath: args.outPath, encoder: args.encoder, candidate: 'raw' }; },
    verify: async args => ({ ok: true, failures: [], warnings: [], metrics: { width: args.expectedWidth } }),
    discoverGifsicle: async () => null
  };
  return { dir, calls, captures, stages, options: { scene, workDir: dir, outPath: path.join(dir, 'primary.gif'), encoder: 'pillow', reservedColors: [], caps: { primaryMaxBytes: 50, hardMaxBytes: 80 }, ...options } };
}

test('ladder stays homogeneous, recaptures 50ms and stops at the first target rung', async () => {
  const h = ladderHarness({ 0: 70, 3: 40, 4: 30 });
  const result = await runLadder(h.options, h.stages);
  assert.equal(result.ok, true);
  assert.equal(result.primary.rung, 3);
  assert.equal(result.safeVariant, 'same-as-primary');
  assert.deepEqual(h.calls.map(a => a.rung.rung), [0, 3]);
  assert.deepEqual(h.captures.map(a => a.stepMs), [40, 50]);
  assert.ok(h.calls.every(a => a.encoder === 'pillow'));
});

test('hard-cap fallback keeps earliest primary, safe rung is separate and grain-free', async () => {
  const h = ladderHarness({ 0: 70, 3: 60, 4: 40 });
  const result = await runLadder(h.options, h.stages);
  assert.equal(result.primary.rung, 0);
  assert.equal(result.safeVariant.status, 'ok');
  assert.equal(result.safeVariant.width, 720);
  assert.equal(h.captures.filter(a => a.stepMs === 50 && a.width === 800).length, 1);
  assert.equal(h.captures.at(-1).scene.grain, false);
  assert.notEqual(h.captures.at(-1).workDir, h.captures.at(-2).workDir);
  assert.equal(fs.statSync(result.primaryPath).size, 70);
  assert.equal(fs.statSync(result.safeVariant.gifPath).size, 40);
});

test('failed ladder preserves previous primary; failed safe variant is explicit', async () => {
  const h = ladderHarness({ 0: 90, 3: 100, 4: 90 });
  fs.writeFileSync(h.options.outPath, 'previous artifact');
  const result = await runLadder(h.options, h.stages);
  assert.equal(result.ok, false);
  assert.equal(result.primaryPath, null);
  assert.equal(fs.readFileSync(h.options.outPath, 'utf8'), 'previous artifact');
  assert.ok(result.ladder.every(a => !a.passed && a.failures.length));
  const partial = ladderHarness({ 0: 70, 3: 60, 4: 60 });
  const failure = await runLadder(partial.options, partial.stages);
  assert.equal(failure.status, 'partial');
  assert.equal(failure.safeVariant.status, 'failed');
});

test('gifsicle candidates are all gated and only a smaller passing candidate is selected', async () => {
  const h = ladderHarness({ 0: 70, 3: 60, 4: 60 });
  h.stages.discoverGifsicle = async () => ({ command: 'injected' });
  h.stages.optimize = async args => { fs.writeFileSync(args.outPath, Buffer.alloc(args.lossy ? 10 : 40)); return { gifPath: args.outPath }; };
  h.stages.verify = async args => ({ ok: !args.lossy, failures: args.lossy ? ['flicker'] : [], warnings: [] });
  const result = await runLadder(h.options, h.stages);
  assert.equal(result.primary.candidate, 'o3');
  assert.equal(result.primary.bytes, 40);
  assert.equal(result.ladder.length, 3);
  assert.equal(result.ladder.find(a => a.candidate === 'lossy').passed, false);
});

test('native and stabilized candidates retain separate gate evidence and native wins only when passing', async () => {
  for (const nativePasses of [true, false]) {
    const h = ladderHarness({ 0: 30 }, { encoder: 'gifski' });
    h.stages.encode = async args => {
      fs.writeFileSync(args.outPath, Buffer.alloc(30));
      const nativePath = args.outPath + '.native.gif';
      fs.writeFileSync(nativePath, Buffer.alloc(40));
      return { gifPath: args.outPath, encoder: 'gifski', postprocess: { applied: true, nativePath } };
    };
    h.stages.verify = async args => {
      const flicker = args.gifPath.endsWith('.native.gif') && !nativePasses ? 9 : 0;
      return { ok: !flicker, failures: flicker ? ['flicker'] : [], warnings: [], metrics: { flickerPixelCount: flicker } };
    };
    const result = await runLadder(h.options, h.stages);
    assert.equal(result.primary.candidate, nativePasses ? 'native' : 'stabilized');
    assert.deepEqual(result.ladder.map(a => [a.candidate, a.bytes, a.flickerPixelCount]),
      [['native', 40, nativePasses ? 0 : 9], ['stabilized', 30, 0]]);
  }
});


test('50ms recaptures cannot override rung 3/4 output dimensions with screenshot metadata', async () => {
  const h = ladderHarness({ 0: 70, 3: 60, 4: 40 });
  h.options.scene.canvas.height = 1100;
  h.stages.capture = async (scene, opts) => {
    h.captures.push({ scene, ...opts });
    return { framesDir: h.dir, framePaths: ['unused-for-injected-encoder'], width: 1600, height: 2200, stepMs: opts.stepMs };
  };
  const checked = [];
  h.stages.verify = async args => { checked.push([args.expectedWidth, args.expectedHeight, args.stepMs]); return { ok: true, failures: [], metrics: { flickerPixelCount: 0 } }; };
  const result = await runLadder(h.options, h.stages);
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.map(a => [a.rung.rung, a.width, a.stepMs]), [[0, 800, 40], [3, 800, 50], [4, 720, 50]]);
  assert.deepEqual(checked, [[800, 1100, 40], [800, 1100, 50], [720, 990, 50]]);
  assert.deepEqual(h.captures.map(c => c.stepMs), [40, 50, 50]);
});
