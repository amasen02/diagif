'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { manifest, platformSpec, verifySha256, verifyBinary, installTool } = require('../scripts/fetch-tools.js');
const { resolvePython, runProcess } = require('../src/python.js');
test('pinned platform map supports only available binary architectures', () => {
  for (const [platform, arch, member] of [['win32', 'x64', 'win/gifski.exe'], ['darwin', 'x64', 'mac/gifski'], ['darwin', 'arm64', 'mac/gifski'], ['linux', 'x64', 'linux/gifski']]) assert.equal(platformSpec('gifski', platform, arch).member, member);
  for (const [platform, arch] of [['linux', 'arm64'], ['win32', 'arm64'], ['freebsd', 'x64']]) assert.equal(platformSpec('gifski', platform, arch), null);
  assert.equal(platformSpec('gifsicle', 'win32', 'x64').member, 'gifsicle.exe');
  for (const platform of ['darwin', 'linux']) assert.equal(platformSpec('gifsicle', platform, 'x64'), null);
  assert.equal(platformSpec('gifski', 'linux', 'x64').filename, 'gifski');
  assert.equal(platformSpec('gifski', 'win32', 'x64').filename, 'gifski.exe');
  assert.equal(manifest.gifski.archiveSha256, 'b9b6591aa163123d737353d9c8581efdf3234d28eeaa45329b31da905cd5a996');
  assert.equal(manifest.gifsicle.archiveSha256, '7e47dd0bfd5ee47f911464c57faeed89a8709a7625dd1c449b16579889539ee8');
  for (const spec of Object.values(manifest)) for (const member of Object.values(spec.members)) assert.match(member.sha256, /^[a-f0-9]{64}$/);
});
test('corrupted archive fixture is rejected before extraction and keeps existing binary', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-corrupt-tools-'));
  const spec = platformSpec('gifski', 'win32', 'x64'); const target = path.join(temp, spec.filename);
  fs.writeFileSync(target, 'existing executable');
  const archive = path.join(temp, 'corrupted-archive.zip'); fs.writeFileSync(archive, Buffer.from('504b0304636f7272757074', 'hex'));
  await assert.rejects(installTool(spec, { binDir: temp, archiveBytes: fs.readFileSync(archive) }), /archive SHA-256 mismatch/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing executable');
  const bytes = Buffer.from('valid fixture'); assert.equal(verifySha256(bytes, crypto.createHash('sha256').update(bytes).digest('hex')).length, 64);
  assert.throws(() => verifyBinary(Buffer.from('corrupt'), spec), /SHA-256 mismatch/);
});
test('verified archive with wrong member digest never promotes or executes bytes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diagif-member-tools-')), archive = path.join(temp, 'fixture.zip');
  const python = await resolvePython();
  const result = await runProcess(python.command, ['-c', 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr("fixture.exe",b"not executable")', archive]);
  assert.equal(result.code, 0, result.stderr);
  const bytes = fs.readFileSync(archive), target = path.join(temp, 'fixture.exe'); fs.writeFileSync(target, 'keep');
  const spec = { name: 'fixture', filename: 'fixture.exe', url: 'https://example.test/fixture.zip', member: 'fixture.exe', platform: 'win32', arch: 'x64', archiveSha256: crypto.createHash('sha256').update(bytes).digest('hex'), binary: { size: 14, sha256: '0'.repeat(64), magic: '4d5a9000' } };
  await assert.rejects(installTool(spec, { binDir: temp, archiveBytes: bytes }), /fixture.exe SHA-256 mismatch/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});
test('binary magic, size and PE/ELF architecture checks run after the member hash', () => {
  const bytes = Buffer.alloc(128); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68);
  const binary = { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), magic: bytes.subarray(0, 4).toString('hex') };
  const spec = { platform: 'win32', member: 'fixture.exe', binary };
  assert.equal(verifyBinary(bytes, spec), true);
  assert.throws(() => verifyBinary(bytes, { ...spec, binary: { ...binary, magic: '00000000' } }), /magic/);
  assert.throws(() => verifyBinary(bytes, { ...spec, binary: { ...binary, size: 1 } }), /size/);
  bytes.writeUInt16LE(0x14c, 68); binary.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.throws(() => verifyBinary(bytes, spec), /AMD64/);
  const elf = Buffer.alloc(64); elf.write('ELF', 1); elf[0] = 0x7f; elf[4] = 2; elf[5] = 1; elf.writeUInt16LE(0x3e, 18);
  const elfSpec = { platform: 'linux', member: 'fixture', binary: { size: elf.length, magic: '7f454c46', sha256: crypto.createHash('sha256').update(elf).digest('hex') } };
  assert.equal(verifyBinary(elf, elfSpec), true);
  elf.writeUInt16LE(0xb7, 18); elfSpec.binary.sha256 = crypto.createHash('sha256').update(elf).digest('hex');
  assert.throws(() => verifyBinary(elf, elfSpec), /x86_64 ELF/);
  const fat = Buffer.alloc(48); fat.writeUInt32BE(0xcafebabe); fat.writeUInt32BE(2, 4); fat.writeUInt32BE(0x01000007, 8); fat.writeUInt32BE(0x0100000c, 28);
  const fatSpec = { platform: 'darwin', member: 'fixture', binary: { size: fat.length, magic: 'cafebabe', sha256: crypto.createHash('sha256').update(fat).digest('hex') } };
  assert.equal(verifyBinary(fat, fatSpec), true);
  fat.writeUInt32BE(0x01000007, 28); fatSpec.binary.sha256 = crypto.createHash('sha256').update(fat).digest('hex');
  assert.throws(() => verifyBinary(fat, fatSpec), /Mach-O slices/);
});
test('explicit unavailable encoder overrides force Pillow without PATH fallback', async () => {
  const keys = ['TECH_GIFS_GIFSKI', 'TECH_GIFS_GIFSICLE'], previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = path.join(os.tmpdir(), 'absent-' + crypto.randomUUID());
    assert.equal(await require('../src/encode/gifski.js').discover(), null);
    assert.equal(await require('../src/encode/gifsicle.js').discover(), null);
    assert.deepEqual(await require('../src/encode/encode.js').chooseEncoder(), { encoder: 'pillow' });
  } finally { keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); }
});
