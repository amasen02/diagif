'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const { buildPageHtml } = require('./page-source.js');
const { normalizeScene } = require('../normalize-scene.js');
const { frameCount } = require('../renderer/timeline.js');
const { absolute, rootPath } = require('../paths.js');
const config = require('../../config/defaults.json');
const playwrightVersion = require('playwright/package.json').version;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function pngDimensions(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot is not a PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function readFixture(file) {
  const svgString = fs.readFileSync(file, 'utf8');
  const match = svgString.match(/<metadata\b[^>]*\bid=["']fixture-scene["'][^>]*>([\s\S]*?)<\/metadata>/i);
  if (!match) throw new Error('Fixture requires metadata#fixture-scene containing authored scene JSON');
  const json = match[1].replace(/&(?:lt|gt|quot|apos|amp);/g, entity => ({ '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' })[entity]);
  return { svgString, scene: normalizeScene(JSON.parse(json)) };
}
async function loadFonts(page) {
  const families = [...new Set(require('../../fonts/manifest.json').files.map(f => f.family))];
  return page.evaluate(async expectedFamilies => {
    await Promise.all([...document.fonts].map(f => f.load()));
    await document.fonts.ready;
    const fonts = [...document.fonts].map(f => ({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status }));
    if (!fonts.length || fonts.some(f => f.status !== 'loaded')) throw new Error('A declared font face failed to load');
    for (const family of expectedFamilies) if (!fonts.some(f => f.family === family) || !document.fonts.check('16px "' + family + '"')) throw new Error('Font fallback detected: ' + family);
    return fonts;
  }, families);
}
async function probeLaunchArgs(browser, launchArgs) {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send('Browser.getBrowserCommandLine');
    const missing = launchArgs.filter(arg => !result.arguments.includes(arg));
    if (missing.length) throw new Error('Chromium launch arguments missing: ' + missing.join(', '));
    return { passed: true, requested: [...launchArgs], present: launchArgs.filter(arg => result.arguments.includes(arg)), browserVersion: browser.version() };
  } finally { await session.detach(); }
}
async function openPage(scene, options = {}) {
  const stepMs = options.stepMs ?? 40;
  frameCount(scene.timeline.durationMs, stepMs);
  const launchArgs = [...new Set([...(options.launchArgs ?? config.launchArgs), '--enable-automation'])];
  const browser = await chromium.launch({ headless: options.headless ?? true, args: launchArgs });
  try {
    const launchArgProbe = await probeLaunchArgs(browser, launchArgs);
    const context = await browser.newContext({ viewport: { width: scene.canvas.width, height: scene.canvas.height }, deviceScaleFactor: 2,
      colorScheme: ['dark-teal', 'black-card', 'ink'].includes(scene.theme) ? 'dark' : 'light', reducedMotion: 'reduce' });
    const page = await context.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()); });
    function assertPage() { if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join('\n')); }
    await page.setContent(buildPageHtml(), { waitUntil: 'load' });
    const fonts = await loadFonts(page);
    const ready = await page.evaluate(step => {
      document.documentElement.setAttribute('data-tech-gif-step-ms', String(step));
      return typeof window.__TECH_GIF__ === 'object' && typeof window.__TECH_GIF__.seek === 'function';
    }, stepMs);
    if (!ready) throw new Error('runtime not injected');
    assertPage();
    const mountInfo = await page.evaluate(({ scene, svgString }) => svgString === undefined ? window.__TECH_GIF__.mount(scene) : window.__TECH_GIF__.mountSvg(svgString, scene), { scene, svgString: options.svgString });
    assertPage();
    async function screenshot(timeMs) {
      await page.evaluate(t => window.__TECH_GIF__.seek(t), timeMs);
      const buffer = await page.screenshot({ type: 'png', scale: 'device', animations: 'disabled' });
      assertPage();
      const dimensions = pngDimensions(buffer);
      if (dimensions.width !== scene.canvas.width * 2 || dimensions.height !== scene.canvas.height * 2) throw new Error('Unexpected screenshot dimensions: ' + JSON.stringify(dimensions));
      return buffer;
    }
    return { browser, context, page, fonts, mountInfo, launchArgs, launchArgProbe, screenshot, assertPage, close: () => browser.close() };
  } catch (error) { await browser.close(); throw error; }
}
function identicalRanges(hashes) {
  const ranges = [];
  let first = 0;
  for (let i = 1; i <= hashes.length; i++) if (i === hashes.length || hashes[i] !== hashes[i - 1]) {
    if (i - first > 1) ranges.push([first, i - 1]);
    first = i;
  }
  return ranges;
}
function metadata(session, scene) {
  return { width: scene.canvas.width * 2, height: scene.canvas.height * 2, fonts: session.fonts,
    browserVersion: session.browser.version(), playwrightVersion, os: os.platform() + ' ' + os.release() + ' ' + os.arch(),
    launchArgs: session.launchArgs, launchArgProbe: session.launchArgProbe, geometrySelfCheck: session.mountInfo.geometrySelfCheck,
    warnings: [...(scene.warnings || []), ...session.mountInfo.warnings], loopSeam: scene.timeline.loopSeam || 'seamless' };
}
async function capture(scene, options = {}) {
  const stepMs = options.stepMs ?? 40, count = frameCount(scene.timeline.durationMs, stepMs);
  const workDir = absolute(options.workDir || rootPath('work', scene.id)), framesDir = absolute(workDir, 'frames-' + stepMs);
  fs.mkdirSync(framesDir, { recursive: true });
  const session = await openPage(scene, options);
  try {
    const framePaths = [], frameHashes = [];
    for (let frame = 0; frame < count; frame++) {
      const bytes = await session.screenshot(frame * stepMs), file = absolute(framesDir, 'frame_' + String(frame).padStart(4, '0') + '.png');
      fs.writeFileSync(file, bytes); framePaths.push(file); frameHashes.push(sha256(bytes));
    }
    const seamPath = absolute(framesDir, 'seam.png'), seam = await session.screenshot(scene.timeline.durationMs);
    fs.writeFileSync(seamPath, seam);
    fs.writeFileSync(absolute(workDir, 'seam.png'), seam);
    if (sha256(seam) !== frameHashes[0]) throw new Error('Loop seam PNG differs from frame_0000.png');
    const ranges = identicalRanges(frameHashes), info = metadata(session, scene);
    if (ranges.length) {
      const warning = 'Byte-identical consecutive PNG ranges: ' + JSON.stringify(ranges);
      info.warnings.push(warning); console.warn(warning);
    }
    const result = { framesDir, framePaths, seamPath, stepMs, frameHashes, identicalRanges: ranges, ...info };
    fs.writeFileSync(absolute(framesDir, 'capture.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { await session.close(); }
}
async function debugFrame(scene, options = {}) {
  const timeMs = options.timeMs ?? 0;
  if (!Number.isFinite(timeMs)) throw new Error('time must be finite');
  const outPath = absolute(options.outPath || rootPath('work', scene.id, 'debug-frame.png'));
  const session = await openPage(scene, options);
  try {
    const bytes = await session.screenshot(timeMs);
    fs.mkdirSync(path.dirname(outPath), { recursive: true }); fs.writeFileSync(outPath, bytes);
    return { outPath, timeMs, sha256: sha256(bytes), ...metadata(session, scene) };
  } finally { await session.close(); }
}
module.exports = { capture, captureFrames: capture, debugFrame, openPage, loadFonts, probeLaunchArgs, readFixture, sha256, pngDimensions, identicalRanges };
