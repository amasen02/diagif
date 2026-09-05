#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { rootPath } = require('../src/paths.js');
const { resolvePython, runProcess } = require('../src/python.js');
const { writeFileAtomic } = require('../src/fs-atomic.js');
const manifest = require('./tool-manifest.json');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function verifySha256(bytes, expected, label = 'archive') {
  const actual = sha256(bytes);
  if (!/^[a-f0-9]{64}$/.test(expected || '') || actual !== expected) throw new Error(label + ' SHA-256 mismatch: expected ' + expected + ', got ' + actual);
  return actual;
}
function platformSpec(name, platform = process.platform, arch = process.arch) {
  const spec = manifest[name];
  if (!spec) throw new Error('Unknown tool: ' + name);
  const member = spec.platforms[platform + '-' + arch];
  if (!member) return null;
  return { name, ...spec, member, binary: spec.members[member], filename: name + (platform === 'win32' ? '.exe' : ''), platform, arch };
}
function verifyBinary(bytes, spec) {
  verifySha256(bytes, spec.binary.sha256, spec.member);
  if (bytes.length !== spec.binary.size || bytes.subarray(0, 4).toString('hex') !== spec.binary.magic) throw new Error('Executable size or magic mismatch: ' + spec.member);
  if (spec.platform === 'win32') {
    const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('hex') !== '50450000' || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Expected an AMD64 PE executable');
  } else if (spec.platform === 'linux') {
    if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 0x3e) throw new Error('Expected an x86_64 ELF executable');
  } else if (spec.platform === 'darwin') {
    const count = bytes.readUInt32BE(4), cpus = [];
    if (8 + count * 20 > bytes.length) throw new Error('Truncated Mach-O fat header');
    for (let i = 0; i < count; i++) cpus.push(bytes.readUInt32BE(8 + i * 20));
    if (!cpus.includes(0x01000007) || !cpus.includes(0x0100000c)) throw new Error('Expected x86_64 and arm64 Mach-O slices');
  }
  return true;
}
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Download HTTP ' + response.status + ': ' + url);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error('Tool archive exceeds 100 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function installTool(spec, { binDir = rootPath('tools/bin'), archiveBytes, fetchArchive = download } = {}) {
  const bytes = archiveBytes || await fetchArchive(spec.url);
  // Reject corruption before any extraction, probe, or destination write.
  verifySha256(bytes, spec.archiveSha256);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-tools-'));
  try {
    const archive = path.join(temporary, spec.url.endsWith('.zip') ? 'archive.zip' : 'archive.tar.xz');
    const extracted = path.join(temporary, spec.filename);
    fs.writeFileSync(archive, bytes);
    const python = await resolvePython();
    const code = [
      'import zipfile,tarfile,sys',
      'from pathlib import Path',
      'archive,member,destination,limit=sys.argv[1:]; limit=int(limit)',
      'if archive.endswith(".zip"):',
      ' with zipfile.ZipFile(archive) as z:',
      '  matches=[i for i in z.infolist() if i.filename==member]',
      '  if len(matches)!=1 or matches[0].is_dir() or matches[0].file_size!=limit: raise ValueError("Invalid archive member")',
      '  with z.open(matches[0]) as f: data=f.read(limit+1)',
      'else:',
      ' with tarfile.open(archive) as z:',
      '  matches=[i for i in z.getmembers() if i.name==member]',
      '  if len(matches)!=1 or not matches[0].isfile() or matches[0].size!=limit: raise ValueError("Invalid archive member")',
      '  with z.extractfile(matches[0]) as f: data=f.read(limit+1)',
      'if len(data)!=limit: raise ValueError("Invalid member length")',
      'Path(destination).write_bytes(data)'
    ].join('\n');
    const result = await runProcess(python.command, ['-c', code, archive, spec.member, extracted, String(spec.binary.size)], { timeout: 120000 });
    if (result.code !== 0) throw new Error('Extraction failed: ' + result.stderr);
    const binary = fs.readFileSync(extracted);
    verifyBinary(binary, spec);
    if (process.platform !== 'win32') fs.chmodSync(extracted, 0o755);
    const version = await runProcess(extracted, ['--version'], { timeout: 15000 });
    const help = await runProcess(extracted, ['--help'], { timeout: 15000 });
    if (version.code !== 0 || help.code !== 0) throw new Error('Downloaded executable probe failed');
    const destination = path.resolve(binDir, spec.filename);
    await writeFileAtomic(destination, binary, { mode: 0o755 });
    if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);
    return { name: spec.name, version: spec.version, path: destination, sha256: sha256(binary), versionOutput: version.stdout.trim() };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function main() {
  const report = { installed: [], skipped: [], failed: [] };
  for (const name of Object.keys(manifest)) {
    const spec = platformSpec(name);
    if (!spec) {
      const guidance = name === 'gifsicle' ? 'Use brew install gifsicle on macOS or sudo apt install gifsicle on Linux; discovered on PATH.' : 'No pinned binary for this architecture; build gifski from source or use Pillow.';
      report.skipped.push({ name, platform: process.platform, arch: process.arch, guidance });
      continue;
    }
    try { report.installed.push(await installTool(spec)); }
    catch (error) { report.failed.push({ name, message: error.message }); }
  }
  console.log(JSON.stringify(report, null, 2));
  return report.failed.length ? 1 : 0;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, manifest, platformSpec, verifySha256, verifyBinary, installTool, download };
