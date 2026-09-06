#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PRIVATE = path.resolve(ROOT, '..', 'tech-gifs-private');
const MAX_GIF_BYTES = 600000;

// Updating a gallery GIF requires a deliberate review and hash change here. This
// prevents a later branded or otherwise unreviewed replacement from being copied.
const REVIEWED_GIF_SHA256 = new Map([
  ['docs/examples/agentic-ai.gif', 'b133d0700eb6b253e80856eb0c302a69d11c8e9f820e26cccf3c575444ed7dc1'],
  ['docs/examples/blue-green-canary-rolling.gif', 'f65a458362bf5de3689671df834cbfba2bffcde9b4ef8916f9eff8993dd4310c'],
  ['docs/examples/mcp-vs-skills.gif', 'ef96d658f3befb2699437e24f3ca04a4b0c12f6bee08721d7e3f45b9db1a9586'],
  ['docs/examples/oauth-pkce.gif', 'a969b44430d3ad455f04512a73e8e684d62d4c95f536e7517e65c8fba42a2d7e'],
  ['docs/examples/rest-cursor-pagination.gif', '2db8caca656031c005080c632004d8a416176a027691eb41b5a9034b7c3a264e'],
  ['docs/examples/sql-leftmost-prefix.gif', '57253480721324d69d7aa42609b325f3b96f0a40d488c58e9935867c42d771a4'],
  ['output/angular-defer-hydration.gif', 'ec285f1c4f8f235cea270057c128589c8a7a4e0a545aef8ca16bf7e36fa4c811'],
  ['output/dotnet-di-lifetimes.gif', '7f384d233d336bf2dbd2f64e81efd9460f41727bd94928a81b3d85764205cc0d'],
  ['output/serverless-containers-vms.gif', '82e4a09e121e42a369b104afe55f265d6ef28410bfe475f4e2ce650798517a95'],
  ['output/modular-monolith.gif', '5c0cc6b6327c9b205891af4bfe7eb9f8e52cff161a37c31e4061a1ddb31530a7'],
  ['output/solid-before-after.gif', 'bcbf36fb7f2c040142f806e2b232bcd37522bcf6158bf3f8680c77fb8f6252ea'],
  ['output/graphrag-vs-vector-rag.gif', '170001d88da657adf51418b4285b24207d09cf385c054b1cd9416ddcc0e0b801']
]);

const SCENES = [
  ['mcp-vs-skills', 'MCP vs Skills', 'AI'],
  ['graphrag-vs-vector-rag', 'Vector RAG vs GraphRAG', 'AI'],
  ['dotnet-di-lifetimes', '.NET dependency injection lifetimes', '.NET'],
  ['angular-defer-hydration', 'Angular defer and hydration', 'Angular'],
  ['serverless-containers-vms', 'Serverless, containers, or VMs', 'Cloud'],
  ['blue-green-canary-rolling', 'Blue-green, canary, and rolling deployments', 'DevOps'],
  ['oauth-pkce', 'OAuth with PKCE', 'Security'],
  ['sql-leftmost-prefix', 'SQL leftmost-prefix indexes', 'SQL'],
  ['rest-cursor-pagination', 'REST cursor pagination', 'REST'],
  ['modular-monolith', 'Modular monolith boundaries', 'Architecture'],
  ['solid-before-after', 'Single responsibility before and after', 'SOLID'],
  ['agent-mock-mindmap', 'Agentic AI control loop', 'Mind map']
];

const GALLERY = [
  ['agentic-ai', 'Agentic AI: a controlled loop', 'AI', 'docs/examples/agentic-ai.gif', 'output/agent-mock-mindmap.gif.quality.json', 'agent-mock-mindmap'],
  ['blue-green-canary-rolling', 'Deployment strategies', 'DevOps', 'docs/examples/blue-green-canary-rolling.gif', 'output/blue-green-canary-rolling.gif.quality.json', 'blue-green-canary-rolling'],
  ['mcp-vs-skills', 'MCP vs Skills', 'Protocols', 'docs/examples/mcp-vs-skills.gif', 'output/mcp-vs-skills.gif.quality.json', 'mcp-vs-skills'],
  ['oauth-pkce', 'OAuth with PKCE', 'Security', 'docs/examples/oauth-pkce.gif', 'output/oauth-pkce.gif.quality.json', 'oauth-pkce'],
  ['rest-cursor-pagination', 'Cursor pagination', 'REST APIs', 'docs/examples/rest-cursor-pagination.gif', 'output/rest-cursor-pagination.gif.quality.json', 'rest-cursor-pagination'],
  ['sql-leftmost-prefix', 'Composite index order', 'SQL', 'docs/examples/sql-leftmost-prefix.gif', 'output/sql-leftmost-prefix.gif.quality.json', 'sql-leftmost-prefix'],
  ['angular-defer-hydration', 'Angular defer and hydration', 'Angular', 'output/angular-defer-hydration.gif', 'output/angular-defer-hydration.gif.quality.json', 'angular-defer-hydration'],
  ['dotnet-di-lifetimes', '.NET dependency injection lifetimes', '.NET', 'output/dotnet-di-lifetimes.gif', 'output/dotnet-di-lifetimes.gif.quality.json', 'dotnet-di-lifetimes'],
  ['serverless-containers-vms', 'Serverless, containers, or VMs', 'Cloud', 'output/serverless-containers-vms.gif', 'output/serverless-containers-vms.gif.quality.json', 'serverless-containers-vms'],
  ['modular-monolith', 'Modular monolith boundaries', 'Architecture', 'output/modular-monolith.gif', 'output/modular-monolith.gif.quality.json', 'modular-monolith'],
  ['solid-before-after', 'One reason to change', 'SOLID', 'output/solid-before-after.gif', 'output/solid-before-after.gif.quality.json', 'solid-before-after'],
  ['graphrag-vs-vector-rag', 'Vector RAG vs GraphRAG', 'Knowledge graphs', 'output/graphrag-vs-vector-rag.gif', 'output/graphrag-vs-vector-rag.gif.quality.json', 'graphrag-vs-vector-rag']
];

const FONT_ROLES = new Set(['display', 'condensed', 'body', 'annotation', 'code', 'labelMono']);
const MANAGED_DIRS = ['fonts', 'scenes', 'gallery', 'licenses'];

function fail(message) { throw new Error(message); }

function parseArgs(argv) {
  const options = { sourcePrivate: DEFAULT_PRIVATE, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') options.out = argv[++i];
    else if (arg === '--source-private') options.sourcePrivate = argv[++i];
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else fail('Unknown argument: ' + arg);
    if ((arg === '--out' || arg === '--source-private') && !argv[i]) fail('Missing value for ' + arg);
  }
  return options;
}

function usage() {
  return 'Usage: node scripts/build-demo-site.js --out <site-root> [--source-private <path>] [--strict]';
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail('Invalid JSON ' + file + ': ' + error.message); }
}

function requireFile(file, label = 'Required file') {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(label + ' is missing: ' + file);
  return file;
}

function requireDir(dir, label = 'Required directory') {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) fail(label + ' is missing: ' + dir);
  return dir;
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function copyFile(source, destination) {
  requireFile(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function relativeAsset(...parts) { return path.posix.join('assets', ...parts); }

function collectStrings(value, at = '$', result = []) {
  if (typeof value === 'string') result.push({ at, value });
  else if (Array.isArray(value)) value.forEach((item, index) => collectStrings(item, `${at}[${index}]`, result));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => collectStrings(item, `${at}.${key}`, result));
  return result;
}

function privateDenylist(sourcePrivate, strict) {
  const file = path.join(sourcePrivate, 'public-denylist.txt');
  if (strict) requireFile(file, 'Private public denylist');
  const values = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  return values.map(value => value.trim()).filter(value => value && !value.startsWith('#'));
}

function auditScene(scene, sourcePrivate, strict) {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) fail('Scene must be an object');
  if (!scene.id || !scene.title?.text || !scene.canvas || !Array.isArray(scene.nodes) || !Array.isArray(scene.edges)) fail('Scene is not normalized: ' + (scene.id || '<unknown>'));
  if (scene.brand?.style !== 'none') fail('Public scene must use brand.style="none": ' + scene.id);
  const hits = [];
  for (const item of collectStrings(scene)) {
    const normalized = item.value.replaceAll('\\', '/').toLowerCase();
    for (const denied of privateDenylist(sourcePrivate, strict)) {
      const token = denied.replaceAll('\\', '/').toLowerCase();
      if (token.length >= 4 && normalized.includes(token)) hits.push(`${item.at}: ${JSON.stringify(denied)}`);
    }
    if (/\b[A-Z]:[\\/]|Users[\\/][^\\/]+/i.test(item.value)) hits.push(`${item.at}: local filesystem path`);
    if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(item.value)) hits.push(`${item.at}: email address`);
  }
  if (hits.length) fail('Private or personal text in scene ' + scene.id + ':\n  ' + [...new Set(hits)].join('\n  '));
  if (strict) {
    const allowedBrandKeys = new Set(['showSaveIcon', 'style']);
    const extra = Object.keys(scene.brand || {}).filter(key => !allowedBrandKeys.has(key));
    if (extra.length) fail('Unexpected public brand fields in ' + scene.id + ': ' + extra.join(', '));
  }
}

function sceneFromBaseline(id, sourcePrivate, strict) {
  const file = requireFile(path.join(sourcePrivate, 'baseline', id + '.normalized.json'), 'Normalized baseline scene');
  const scene = readJson(file);
  if (scene.id !== id) fail(`Scene id mismatch in ${file}: expected ${id}, got ${scene.id}`);
  auditScene(scene, sourcePrivate, strict);
  return { scene, bytes: fs.readFileSync(file) };
}

function normalizedMindmap(sourcePrivate, strict) {
  const authoredFile = requireFile(path.join(ROOT, 'test', 'fixtures', 'agent-mock-mindmap.json'), 'Authored mind-map fixture');
  const authored = readJson(authoredFile);
  authored.brand = { style: 'none' };
  const { normalizeScene } = require(path.join(ROOT, 'src', 'normalize-scene.js'));
  if (typeof normalizeScene !== 'function') fail('normalizeScene export is unavailable');
  const scene = normalizeScene(authored);
  if (scene.id !== 'agent-mock-mindmap') fail('Generated mind-map id changed unexpectedly');
  auditScene(scene, sourcePrivate, strict);
  return { scene, bytes: Buffer.from(JSON.stringify(scene, null, 2) + '\n') };
}

function buildRenderer(assetsRoot) {
  const moduleNames = readJson(requireFile(path.join(ROOT, 'src', 'renderer', 'manifest.json'), 'Renderer manifest'));
  if (!Array.isArray(moduleNames) || !moduleNames.length) fail('Renderer manifest must be a non-empty array');
  const sections = moduleNames.map(name => {
    if (!/^[a-z0-9-]+$/.test(name)) fail('Unsafe renderer module name: ' + name);
    const file = requireFile(path.join(ROOT, 'src', 'renderer', name + '.js'), 'Renderer module');
    return `/* module: ${name} */\n${fs.readFileSync(file, 'utf8').trimEnd()}\n`;
  });
  const contents = Buffer.from(`/* Generated by scripts/build-demo-site.js. UMD modules follow src/renderer/manifest.json order. */\n${sections.join('\n')}`);
  const output = path.join(assetsRoot, 'renderer.js');
  writeFile(output, contents);
  return { file: relativeAsset('renderer.js'), modules: moduleNames, bytes: contents.length, sha256: sha256(contents) };
}

function buildFonts(assetsRoot) {
  const sourceManifest = readJson(requireFile(path.join(ROOT, 'fonts', 'manifest.json'), 'Font manifest'));
  const selected = sourceManifest.files.filter(font => FONT_ROLES.has(font.weightRole) && (font.weightRole !== 'labelMono' || font.weight === '700'));
  if (selected.length !== FONT_ROLES.size) fail('Expected exactly one font face for each required role');
  const css = [];
  const files = [];
  const licenses = new Set();
  for (const font of selected) {
    const source = requireFile(path.join(ROOT, 'fonts', font.file), 'Font file');
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== font.sha256) fail('Font hash mismatch: ' + font.file);
    const outputRelative = font.file.replace(/\.ttf$/i, '.woff2');
    const output = path.join(assetsRoot, 'fonts', outputRelative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const python = process.env.TECH_GIFS_PYTHON || 'python';
    const converter = 'import sys; from fontTools.ttLib import TTFont; f=TTFont(sys.argv[1], recalcTimestamp=False); f.flavor="woff2"; f.save(sys.argv[2])';
    const result = childProcess.spawnSync(python, ['-c', converter, source, output], { encoding: 'utf8', shell: false, windowsHide: true });
    if (result.error || result.status !== 0) fail('WOFF2 conversion failed for ' + font.file + '. Install fonttools and brotli (`python -m pip install fonttools brotli`). ' + (result.error?.message || result.stderr || ''));
    const outputBytes = fs.readFileSync(requireFile(output, 'Converted WOFF2 font'));
    if (outputBytes.subarray(0, 4).toString('ascii') !== 'wOF2') fail('Invalid WOFF2 output: ' + output);
    licenses.add(font.license);
    const url = './fonts/' + outputRelative.replaceAll('\\', '/');
    css.push(`@font-face{font-family:${JSON.stringify(font.family)};src:url(${JSON.stringify(url)}) format("woff2");font-weight:${font.weight};font-style:normal;font-display:block;}`);
    files.push({ family: font.family, weightRole: font.weightRole, weight: font.weight, file: relativeAsset('fonts', outputRelative.replaceAll('\\', '/')), bytes: outputBytes.length, sha256: sha256(outputBytes), sourceSha256: font.sha256, license: relativeAsset('fonts', font.license.replaceAll('\\', '/')) });
  }
  for (const license of licenses) copyFile(path.join(ROOT, 'fonts', license), path.join(assetsRoot, 'fonts', license));
  const cssBytes = Buffer.from(css.join('\n') + '\n');
  writeFile(path.join(assetsRoot, 'fonts.css'), cssBytes);
  writeFile(path.join(assetsRoot, 'fonts', 'manifest.json'), JSON.stringify({ files, licenses: [...licenses].map(file => relativeAsset('fonts', file.replaceAll('\\', '/'))) }, null, 2) + '\n');
  return { css: relativeAsset('fonts.css'), files, declaredBytes: files.reduce((sum, file) => sum + file.bytes, 0), cssBytes: cssBytes.length };
}

function buildLicenses(assetsRoot) {
  const licenses = [
    ['lucide-LICENSE.txt', path.join(ROOT, 'assets', 'icons', 'lucide', 'LICENSE')],
    ['simple-icons-LICENSE.txt', path.join(ROOT, 'assets', 'icons', 'brands', 'LICENSE')]
  ];
  return licenses.map(([name, source]) => {
    copyFile(source, path.join(assetsRoot, 'licenses', name));
    return relativeAsset('licenses', name);
  });
}

function portableQuality(source, gifBytes) {
  const quality = readJson(requireFile(source, 'GIF quality report'));
  if (!Array.isArray(quality.failures) || quality.failures.length) fail('GIF quality report has failures: ' + source);
  if (quality.bytes !== undefined && quality.bytes !== gifBytes) fail(`GIF/report byte mismatch: ${source} says ${quality.bytes}, GIF has ${gifBytes}`);
  return {
    failures: [],
    expectedFrames: quality.expectedFrames, loopSeamOk: quality.loopSeamOk,
    width: quality.width, height: quality.height, loop: quality.loop,
    bytes: gifBytes, frames: quality.frames, mergedFrames: quality.mergedFrames,
    delays: quality.delays, totalMs: quality.totalMs,
    staticRegionMaxDiff: quality.staticRegionMaxDiff,
    flickerPixelCount: quality.flickerPixelCount
  };
}

function buildGallery(assetsRoot, sourcePrivate, strict) {
  return GALLERY.map(([id, title, domain, gifRelative, qualityRelative, sceneId]) => {
    const associatedScene = readJson(requireFile(path.join(assetsRoot, 'scenes', sceneId + '.json'), 'Associated public scene'));
    if (associatedScene.id !== sceneId) fail(`Gallery scene id mismatch: ${sceneId}`);
    auditScene(associatedScene, sourcePrivate, strict);
    const source = requireFile(path.join(ROOT, ...gifRelative.split('/')), 'Gallery GIF');
    const bytes = fs.statSync(source).size;
    if (bytes >= MAX_GIF_BYTES) fail(`Gallery GIF must be smaller than ${MAX_GIF_BYTES} bytes: ${source} (${bytes})`);
    const digest = sha256(fs.readFileSync(source));
    if (REVIEWED_GIF_SHA256.get(gifRelative) !== digest) fail('Gallery GIF has not passed the public visual review: ' + gifRelative);
    const quality = portableQuality(path.join(ROOT, ...qualityRelative.split('/')), bytes);
    const file = relativeAsset('gallery', id + '.gif');
    const qualityFile = file + '.quality.json';
    copyFile(source, path.join(assetsRoot, 'gallery', id + '.gif'));
    writeFile(path.join(assetsRoot, 'gallery', id + '.gif.quality.json'), JSON.stringify(quality, null, 2) + '\n');
    return { id, title, domain, file, qualityFile, width: quality.width, height: quality.height, bytes, sha256: digest };
  });
}

function buildScenes(assetsRoot, sourcePrivate, strict) {
  return SCENES.map(([id, title, domain]) => {
    const loaded = id === 'agent-mock-mindmap' ? normalizedMindmap(sourcePrivate, strict) : sceneFromBaseline(id, sourcePrivate, strict);
    if (loaded.scene.id !== id) fail(`Mounted scene id mismatch: manifest ${id}, normalized ${loaded.scene.id}`);
    const file = relativeAsset('scenes', id + '.json');
    writeFile(path.join(assetsRoot, 'scenes', id + '.json'), loaded.bytes);
    return { id, title, domain, file };
  });
}

function assertSafeOutput(out) {
  const resolved = path.resolve(out);
  const normalized = resolved.toLowerCase();
  const source = ROOT.toLowerCase();
  if (resolved === path.parse(resolved).root || normalized === source || normalized.startsWith(source + path.sep)) fail('Refusing unsafe output directory: ' + resolved);
  return resolved;
}

function assertManagedPath(outReal, target) {
  const resolved = path.resolve(target);
  const rootKey = outReal.toLowerCase(), targetKey = resolved.toLowerCase();
  if (!targetKey.startsWith(rootKey + path.sep)) fail('Managed target escapes output root: ' + resolved);
  let cursor = resolved;
  while (cursor.toLowerCase() !== rootKey) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail('Managed target traverses a symbolic link: ' + cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('Could not prove managed target is inside output root: ' + resolved);
    cursor = parent;
  }
  const pending = fs.existsSync(resolved) && fs.lstatSync(resolved).isDirectory() ? [resolved] : [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail('Managed target contains a symbolic link: ' + child);
      if (entry.isDirectory()) pending.push(child);
    }
  }
}

function assertUnique(values, label) {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length) fail(`Duplicate ${label}: ${[...new Set(duplicates)].join(', ')}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  if (!options.out) fail('--out is required\n' + usage());
  const out = assertSafeOutput(options.out);
  const sourcePrivate = requireDir(path.resolve(options.sourcePrivate), 'Private source directory');
  fs.mkdirSync(out, { recursive: true });
  if (fs.lstatSync(out).isSymbolicLink()) fail('Output root must not be a symbolic link: ' + out);
  const outReal = fs.realpathSync(out);
  const assetsRoot = path.join(out, 'assets');
  fs.mkdirSync(assetsRoot, { recursive: true });
  assertManagedPath(outReal, assetsRoot);
  for (const directory of MANAGED_DIRS) {
    const target = path.join(assetsRoot, directory);
    assertManagedPath(outReal, target);
    fs.rmSync(target, { recursive: true, force: true });
  }
  for (const file of ['renderer.js', 'fonts.css', 'manifest.json']) {
    const target = path.join(assetsRoot, file);
    assertManagedPath(outReal, target);
    fs.rmSync(target, { force: true });
  }

  const renderer = buildRenderer(assetsRoot);
  const fonts = buildFonts(assetsRoot);
  const licenses = buildLicenses(assetsRoot);
  const scenes = buildScenes(assetsRoot, sourcePrivate, options.strict);
  const gallery = buildGallery(assetsRoot, sourcePrivate, options.strict);
  if (scenes.length !== 12 || gallery.length !== 12) fail('Demo manifest must contain exactly 12 scenes and 12 gallery items');
  assertUnique(scenes.map(scene => scene.id), 'scene ids');
  assertUnique(gallery.map(item => item.id), 'gallery ids');
  assertUnique(gallery.map(item => item.domain), 'gallery domains');
  assertUnique(gallery.map(item => item.sha256), 'gallery GIF hashes');

  const manifest = { version: 1, renderer, fonts, licenses, scenes, gallery };
  writeFile(path.join(assetsRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ out, manifest: relativeAsset('manifest.json'), scenes: scenes.length, gallery: gallery.length, rendererBytes: renderer.bytes, declaredFontBytes: fonts.declaredBytes, fontsCssBytes: fonts.cssBytes }, null, 2));
}

try { main(); }
catch (error) {
  console.error('build-demo-site: ' + error.message);
  process.exitCode = 1;
}
