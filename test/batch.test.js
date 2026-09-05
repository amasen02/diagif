'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, forward } = require('../src/paths.js');
const { expandInputs, runBatch } = require('../src/batch.js');
const { normalizeScene } = require('../src/normalize-scene.js');

async function fixture(ids = ['alpha', 'bravo', 'charlie']) {
  await fs.mkdir(path.join(ROOT, 'work'), { recursive: true });
  const root = await fs.mkdtemp(path.join(ROOT, 'work', 'batch-test-'));
  await fs.mkdir(path.join(root, 'scenes'));
  await fs.mkdir(path.join(root, 'output'));
  const template = JSON.parse(await fs.readFile(path.join(ROOT, 'scenes/react-loop.json'), 'utf8'));
  const inputs = [];
  for (const id of ids) {
    const input = path.join(root, 'scenes', id + '.json');
    await fs.writeFile(input, JSON.stringify({ ...template, id }));
    inputs.push(input);
  }
  await fs.writeFile(path.join(root, 'output', 'unrelated.gif'), 'do not change');
  return { root, inputs };
}

function stubStages({ failStage, failId = 'bravo', rejected = false } = {}) {
  return {
    async capture(scene, { workDir, stepMs, launchArgs }) {
      if (failStage === 'capture' && scene.id === failId) throw new Error('capture exploded');
      const framesDir = path.join(workDir, 'frames-' + stepMs);
      await fs.mkdir(framesDir, { recursive: true });
      return { framesDir, framePaths: [path.join(framesDir, 'frame_0000.png')],
        seamPath: path.join(framesDir, 'seam.png'), width: 1600, height: 2000,
        fonts: [{ family: 'Inter', status: 'loaded' }], frameHashes: ['stub-hash'], identicalRanges: [],
        browserVersion: 'stub-browser', playwrightVersion: 'stub-playwright', os: 'stub-os', launchArgs };
    },
    async encode({ scene, outPath, stepMs, rung, reservedColors }) {
      assert.ok([40, 50].includes(stepMs));
      assert.equal(rung.width, 800);
      assert.deepEqual(reservedColors, ['#123456']);
      assert.ok(forward(outPath).includes('/work/' + scene.id + '/'));
      await fs.writeFile(outPath, 'candidate for ' + scene.id);
      if (failStage === 'encode' && scene.id === failId) throw new Error('encode exploded after writing');
      return { gifPath: outPath, encoder: 'stub', encoderVersion: 'test', rung: rung.rung, candidate: 'raw', bytes: 9999999, argv: [] };
    },
    async verify(job) {
      const id = (await fs.readFile(job.gifPath, 'utf8')).replace('candidate for ', '');
      assert.equal(job.expectedWidth, 800);
      assert.equal(job.expectedHeight, 1000);
      assert.equal(job.expectedDurationMs, 4000);
      assert.equal(job.maxBytes, 8000000);
      assert.deepEqual(job.reservedColors, ['#123456']);
      if (failStage === 'verify' && id === failId) throw new Error('verify exploded');
      return { ok: !(rejected && id === failId), failures: rejected && id === failId ? ['seam mismatch'] : [], warnings: [],
        metrics: { frames: 100, mergedFrames: 0, loopSeamOk: true, flickerPixelCount: 0, staticRegionMaxDiff: 0, reservedColorHits: { '#123456': 20 } } };
    }
  };
}

const optionsFor = root => ({ rootDir: root, maxParallelScenes: 2, reservedColors: ['#123456'] });

test('agent outputDir and workRoot are independent and failed replacement preserves promoted output', async () => {
  const { root, inputs } = await fixture(['alpha']);
  const outputDir = path.join(root, 'agent-out/run'), workRoot = path.join(root, 'agent-work/a1');
  const stages = stubStages();
  stages.encode = async ({ outPath }) => { assert.ok(outPath.startsWith(forward(path.join(root, 'agent-work')))); await fs.writeFile(outPath, 'candidate for alpha'); return { gifPath: outPath, encoder: 'stub' }; };
  const options = { ...optionsFor(root), outputDir, workRoot, manifestPath: path.join(outputDir, 'steps/04-render-a1.manifest.json') };
  const first = await runBatch(inputs, stages, options); assert.equal(first.exitCode, 0);
  assert.equal(first.manifest.scenes[0].workDir, forward(path.join(workRoot, 'alpha')));
  assert.equal(await fs.readFile(path.join(outputDir, 'alpha.gif'), 'utf8'), 'candidate for alpha');
  stages.verify = async () => ({ ok: false, failures: ['seam mismatch'] });
  const second = await runBatch(inputs, stages, { ...options, workRoot: path.join(root, 'agent-work/a2'), manifestPath: path.join(outputDir, 'steps/04-render-a2.manifest.json') });
  assert.equal(second.exitCode, 1);
  assert.equal(second.manifest.scenes[0].stage, 'verify');
  assert.equal(await fs.readFile(path.join(outputDir, 'alpha.gif'), 'utf8'), 'candidate for alpha');
  await fs.access(first.manifestPath); await fs.access(second.manifestPath);
  await assert.rejects(fs.access(path.join(root, 'output/alpha.gif')), { code: 'ENOENT' });
});

test('selected ladder grid, hashes and failed native evidence reach the final batch manifest', async () => {
  const { root, inputs } = await fixture(['alpha']);
  const stages = stubStages(), baseEncode = stages.encode;
  const ladder = [{ rung: 0, candidate: 'native', bytes: 40, passed: false, failures: ['flicker'], flickerPixelCount: 9 },
    { rung: 3, candidate: 'stabilized', bytes: 19, passed: true, failures: [], flickerPixelCount: 0 }];
  const framesDir = path.join(root, 'work/alpha/frames-50');
  stages.encode = async args => ({ ...await baseEncode(args), stepMs: 50, rung: 3,
    candidate: 'stabilized', ladder, framesDir, captured: { framesDir, frameHashes: ['selected-grid'] } });
  stages.verify = async args => {
    assert.equal(args.framesDir, framesDir); assert.equal(args.stepMs, 50);
    return { ok: true, failures: [], warnings: [], metrics: { frames: 80, mergedFrames: 0, loopSeamOk: true, flickerPixelCount: 0 } };
  };
  const result = await runBatch(inputs, stages, optionsFor(root));
  assert.equal(result.exitCode, 0);
  const entry = result.manifest.scenes[0];
  assert.equal(entry.stepMs, 50); assert.equal(entry.frameCount, 80);
  assert.deepEqual(entry.frameHashes, ['selected-grid']); assert.deepEqual(entry.ladder, ladder);
});

test('backslash literal/glob inputs resolve, deduplicate and reject an empty union', async () => {
  const { root, inputs } = await fixture();
  assert.deepEqual(expandInputs(['scenes\\alpha.json'], { cwd: root }), [forward(inputs[0])]);
  assert.deepEqual(expandInputs(['scenes\\*.json', inputs[0]], { cwd: root }), inputs.map(forward));
  assert.throws(() => expandInputs(['missing/*.json'], { cwd: root }), /No input scenes matched/);
  assert.throws(() => expandInputs([]), /No input scenes matched/);
});

for (const failStage of ['capture', 'encode', 'verify']) {
  test(failStage + ' failure preserves existing outputs and produces a complete durable manifest', async () => {
    const { root, inputs } = await fixture();
    const previous = path.join(root, 'output/bravo.gif');
    await fs.writeFile(previous, 'previous verified bravo');
    const result = await runBatch(inputs, stubStages({ failStage }), optionsFor(root));
    assert.equal(result.exitCode, 1);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.scenes.length, inputs.length);
    assert.deepEqual(manifest.scenes.map(e => e.status), ['ok', 'failed', 'ok']);
    assert.equal(manifest.scenes[1].stage, failStage);
    assert.match(manifest.scenes[1].error, /exploded/);
    assert.equal(await fs.readFile(previous, 'utf8'), 'previous verified bravo');
    for (const id of ['alpha', 'charlie']) assert.equal(await fs.readFile(path.join(root, 'output', id + '.gif'), 'utf8'), 'candidate for ' + id);
    assert.equal(await fs.readFile(path.join(root, 'output/unrelated.gif'), 'utf8'), 'do not change');
    const success = manifest.scenes[0];
    assert.equal(success.bytes, Buffer.byteLength('candidate for alpha'));
    assert.equal(success.frameCount, 100);
    assert.equal(success.safeVariant, 'same-as-primary');
    assert.equal(success.loopSeamOk, true);
    assert.equal(success.ladder[0].passed, true);
    assert.equal(success.fonts[0].status, 'loaded');
    assert.equal(success.animations.find(a => a.kind === 'pulse').cycles, 2);
    if (failStage === 'verify') assert.match(manifest.scenes[1].ladder[0].failures[0], /verify exploded/);
  });
}

test('quality rejection never promotes a candidate', async () => {
  const { root, inputs } = await fixture();
  const result = await runBatch(inputs, stubStages({ rejected: true }), optionsFor(root));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.manifest.scenes[1].ladder[0].failures, ['seam mismatch']);
  await assert.rejects(fs.access(path.join(root, 'output/bravo.gif')), { code: 'ENOENT' });
});

test('malformed JSON, invalid scenes and missing literals each get a failure entry while valid input runs', async () => {
  const { root, inputs } = await fixture();
  await fs.writeFile(inputs[0], '{broken');
  await fs.writeFile(inputs[1], JSON.stringify({ id: '../escape' }));
  const result = await runBatch([...inputs, path.join(root, 'scenes/missing.json')], stubStages(), optionsFor(root));
  assert.equal(result.manifest.scenes.length, 4);
  assert.equal(result.manifest.scenes.filter(e => e.status === 'failed').length, 3);
  assert.equal(result.manifest.scenes.find(e => e.id === 'charlie').status, 'ok');
  assert.equal(result.exitCode, 1);
});

test('duplicate scene IDs fail before either input can touch its shared work directory', async () => {
  const { root, inputs } = await fixture(['alpha', 'bravo']);
  await fs.copyFile(inputs[0], inputs[1]);
  let captures = 0;
  const stages = stubStages();
  stages.capture = async () => { captures++; throw new Error('should not capture'); };
  const result = await runBatch(inputs, stages, optionsFor(root));
  assert.equal(captures, 0);
  assert.equal(result.manifest.scenes.length, 2);
  assert.ok(result.manifest.scenes.every(e => /Duplicate scene id/.test(e.error)));
});

for (const limit of [1, 2, 3]) {
  test('maxParallelScenes=' + limit + ' bounds the complete pipeline and fills available slots', async () => {
    const { root, inputs } = await fixture(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
    const stages = stubStages();
    let active = 0, peak = 0;
    const capture = stages.capture, verify = stages.verify;
    stages.capture = async (...args) => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      return capture(...args);
    };
    stages.verify = async job => {
      await new Promise(resolve => setTimeout(resolve, 20));
      try { return await verify(job); } finally { active--; }
    };
    const result = await runBatch(inputs, stages, { ...optionsFor(root), maxParallelScenes: limit });
    assert.equal(result.exitCode, 0);
    assert.equal(peak, limit);
    assert.equal(active, 0);
    assert.deepEqual(result.manifest.scenes.map(e => e.id), ['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });
}

test('invalid concurrency is rejected before stages start', async () => {
  const { root, inputs } = await fixture(['alpha']);
  for (const maxParallelScenes of [0, -1, 1.5, Infinity, '2']) {
    await assert.rejects(runBatch(inputs, {}, { rootDir: root, maxParallelScenes }), /positive integer/);
  }
});

test('render command exits 1 only after writing all entries when an injected stage throws', async () => {
  const { root, inputs } = await fixture();
  const command = path.join(ROOT, 'src/commands/render.js');
  const script = `const fs=require('node:fs');
    require(${JSON.stringify(command)}).run(${JSON.stringify(inputs)}, {
      rootDir: ${JSON.stringify(root)},
      stages: { capture: async () => { throw new Error('injected capture failure'); }, encode: async () => {}, verify: async () => {} }
    }).then(result => {
      const manifest=JSON.parse(fs.readFileSync(result.manifestPath));
      if(manifest.scenes.length!==3) throw new Error('manifest incomplete at return');
      console.log('DURABLE_ENTRIES='+manifest.scenes.length);
    }).catch(e=>{console.error(e);process.exitCode=2;});`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: ROOT, shell: false, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /DURABLE_ENTRIES=3/);
  assert.match(result.stdout, /injected capture failure/);
});

test('smoke scenes retain the required loop constructs and all eight SQL steps', async () => {
  const read = async id => normalizeScene(JSON.parse(await fs.readFile(path.join(ROOT, 'scenes', id + '.json'), 'utf8')));
  const react = await read('react-loop');
  assert.ok(react.edges.some(e => e.from === e.to && e.loop && e.label.text === 'retry until pass'));
  assert.ok(react.edges.some(e => e.from === 'llm' && e.to === 'agent' && e.curveOffset !== 0));
  assert.equal(react.timeline.animations.find(a => a.kind === 'pulse').cycles, 2);
  const sql = await read('sql-execution-order');
  assert.equal(sql.theme, 'paper'); assert.equal(sql.grain, true);
  assert.equal(sql.nodes.filter(n => n.shape === 'step').length, 8);
  const code = sql.annotations.find(a => a.kind === 'code');
  assert.equal(code.language, 'sql'); assert.equal(code.lines.length, 8);
  assert.ok(code.lines.every(line => line.band));
  assert.deepEqual(code.lines.map(line => line.badge.n).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  const highlight = sql.timeline.animations.find(a => a.kind === 'sequential-highlight');
  assert.equal(highlight.dwellMs, 800); assert.equal(highlight.transitionMs, 120);
  assert.equal(highlight.dwellMs * highlight.order.length, 6400);
  assert.ok(sql.timeline.animations.some(a => a.kind === 'marching-dash'));
});

test('README includes an example row for every frozen schema property', async () => {
  const schema = require('../src/schema/scene.schema.json');
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  let count = 0;
  function walk(raw, prefix) {
    const s = raw.$ref ? schema.$defs[raw.$ref.split('/').pop()] : raw;
    for (const [key, value] of Object.entries(s.properties || {})) {
      const field = prefix ? prefix + '.' + key : key;
      const row = readme.split('\n').find(line => line.startsWith('| `' + field + '` |'));
      assert.ok(row, 'Missing README field: ' + field);
      assert.match(row, / \| `.+` \|$/, 'Missing example: ' + field);
      count++;
      if (value.items?.oneOf) {
        for (const branch of value.items.oneOf) walk(branch, field + '[kind=' + branch.properties.kind.const + ']');
      } else if (value.items) walk(value.items, field + '[]');
      else walk(value, field);
    }
  }
  walk(schema, '');
  assert.ok(count > 200);
});
