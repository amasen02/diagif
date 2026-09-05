'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scan, isAllowed, hasLineAllowMarker } = require('../scripts/sanitize-public-docs');
const cli = path.resolve(__dirname, '../scripts/sanitize-public-docs.js');
const bs = String.fromCharCode(92);
const signatures = [
  ['OPENAI', 'API_KEY'].join('_') + '=sample',
  'sk-' + 'abcdefgh1234', ['AI', 'za'].join('') + 'sample',
  'BEGIN ' + 'PRIVATE KEY', 'BEGIN RSA ' + 'PRIVATE KEY', 'BEGIN EC ' + 'PRIVATE KEY',
  ['D:', 'Users', 'Example'].join(bs), ['C:', 'example'].join(bs),
  ['/home', 'example', 'repo'].join('/') + '/',
  'https://' + 'example.internal', 'http://' + 'corp.example', 'https://' + 'example.local'
];

function fixture(t) {
  const tempBase = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempBase, 'gif-sanitize-'));
  t.after(() => {
    const resolved = fs.realpathSync(dir);
    assert.equal(path.dirname(resolved), tempBase);
    assert.ok(path.basename(resolved).startsWith('gif-sanitize-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return dir;
}
function write(dir, name, data) {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}
function git(dir, args) {
  const result = spawnSync('git', args, { cwd: dir, shell: false, windowsHide: true, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test('every built-in signature produces a file and exact line without echoing secrets', t => {
  const dir = fixture(t);
  write(dir, 'notes with spaces.md', 'safe\n' + signatures.join('\n') + '\n');
  const report = scan({ rootDir: dir });
  assert.equal(report.hits.length, signatures.length);
  assert.deepEqual(report.hits.map(hit => hit.line), signatures.map((_, i) => i + 2));
  const result = spawnSync(process.execPath, [cli, '--check'], {
    cwd: dir, shell: false, windowsHide: true, encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /notes with spaces\.md:2:/);
  assert.ok(!result.stderr.includes(signatures[0]));
});

test('external denylist treats Windows paths and regex punctuation as literal text', t => {
  const dir = fixture(t), external = fixture(t);
  const denied = ['Z:', 'project'].join(bs);
  const list = path.join(external, 'private list.txt');
  write(external, 'private list.txt', denied + '\nprivate.brand\n');
  write(dir, 'notes.md', `${denied}\nprivate.brand\nprivateXbrand\n`);
  const report = scan({ rootDir: dir, denylist: list });
  assert.deepEqual(report.hits.map(hit => hit.line), [1, 2]);
  assert.throws(() => scan({ rootDir: dir, denylist: path.join(external, 'missing') }));
});

test('public link exception is limited to the named files and matching line', t => {
  const dir = fixture(t), external = fixture(t);
  const owner = ['ama', 'sen02'].join('');
  const link = 'https://github.com/' + owner + '/diagif';
  write(external, 'deny.txt', owner);
  for (const name of ['package.json', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
    write(dir, name, `${link}\n${owner}\n`);
  }
  write(dir, 'docs/README.md', link);
  const report = scan({ rootDir: dir, denylist: path.join(external, 'deny.txt') });
  assert.equal(report.hits.length, 5);
  assert.equal(report.hits.find(hit => hit.file === 'README.md').line, 2);
  assert.ok(isAllowed('README.md', 'https://npmjs.com/package/diagif'));
  assert.ok(!isAllowed('LICENSE', link));
});

test('working tree scan respects ignores, includes hidden files, and skips binary assets', t => {
  const dir = fixture(t);
  write(dir, '.gitignore', 'output/\n.env\n');
  write(dir, 'output/private.md', signatures[0]);
  write(dir, '.env', signatures[0]);
  write(dir, 'fonts/font.ttf', Buffer.from([0, 1, 2, 3]));
  write(dir, '.github/note.md', signatures[0]);
  const report = scan({ rootDir: dir });
  assert.equal(report.mode, 'working tree');
  assert.deepEqual(report.hits.map(hit => hit.file), ['.github/note.md']);
  assert.equal(report.files, 3);
});

test('nested ignored checkout falls back to its own tree, never the parent index', t => {
  const dir = fixture(t);
  git(dir, ['init', '--quiet']);
  write(dir, '.gitignore', 'checkout/\n');
  write(dir, 'parent.md', signatures[0]);
  git(dir, ['add', '.gitignore', 'parent.md']);
  write(dir, 'checkout/.gitignore', 'work/\n');
  write(dir, 'checkout/work/ignored.md', signatures[0]);
  write(dir, 'checkout/notes.md', signatures[1]);
  const report = scan({ rootDir: path.join(dir, 'checkout') });
  assert.equal(report.mode, 'working tree');
  assert.deepEqual(report.hits.map(hit => hit.file), ['notes.md']);
});

test('own repository scans tracked files even if ignored, and omits untracked files', t => {
  const dir = fixture(t);
  git(dir, ['init', '--quiet']);
  write(dir, '.gitignore', 'ignored.md\n');
  write(dir, 'ignored.md', signatures[0]);
  write(dir, 'untracked.md', signatures[1]);
  git(dir, ['add', '.gitignore']);
  git(dir, ['add', '--force', 'ignored.md']);
  const report = scan({ rootDir: dir });
  assert.equal(report.mode, 'git ls-files');
  assert.deepEqual(report.hits.map(hit => hit.file), ['ignored.md']);
});

test('CLI succeeds on clean text and rejects missing or ambiguous arguments', t => {
  const dir = fixture(t);
  write(dir, 'notes.md', 'Public methodology.\n');
  for (const args of [[], ['--unknown'], ['--check', '--check'], ['--check', '--denylist']]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: dir, shell: false, windowsHide: true, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const result = spawnSync(process.execPath, [cli, '--check'], {
    cwd: dir, shell: false, windowsHide: true, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 hit\(s\)/);
});

test('line allow markers exempt only their marked JavaScript, Python, and Markdown line', t => {
  const dir = fixture(t);
  write(dir, 'fixture.js', `${signatures[0]} // sanitize-allow: test secret-shaped value\n${signatures[1]}\n`);
  write(dir, 'fixture.py', `${signatures[2]} # sanitize-allow: wrong syntax\n`);
  write(dir, 'fixture.md', `${signatures[3]} <!-- sanitize-allow: fixture key header -->\n${signatures[4]}\n`);
  const report = scan({ rootDir: dir });
  assert.deepEqual(report.hits.map(hit => `${hit.file}:${hit.line}`), ['fixture.js:2', 'fixture.md:2', 'fixture.py:1']);
  assert.ok(hasLineAllowMarker('fixture.js', '// sanitize-allow: documented fixture'));
  assert.ok(hasLineAllowMarker('fixture.md', '<!-- sanitize-allow: documented fixture -->'));
  assert.ok(!hasLineAllowMarker('fixture.txt', '// sanitize-allow: fixture'));
});

test('pure Node fallback works with Git and ripgrep absent from PATH', t => {
  const dir = fixture(t), emptyPath = fixture(t);
  write(dir, '.gitignore', 'ignored/\n');
  write(dir, 'ignored/private.md', signatures[0]);
  write(dir, 'nested/visible.md', signatures[1]);
  const env = { PATH: emptyPath, PATHEXT: '.EXE' };
  const report = scan({ rootDir: dir, env });
  assert.equal(report.mode, 'working tree');
  assert.deepEqual(report.hits.map(hit => `${hit.file}:${hit.line}`), ['nested/visible.md:1']);
  const result = spawnSync(process.execPath, [cli, '--check'], {
    cwd: dir, env: { ...process.env, PATH: emptyPath, PATHEXT: '.EXE' }, shell: false, windowsHide: true, encoding: 'utf8'
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /nested[\\/]visible\.md:1:/);
});

test('pure Node fallback matches ripgrep denylist handling for trailing and blank lines', t => {
  const dir = fixture(t), emptyPath = fixture(t);
  write(dir, 'notes.md', 'needle\nother\n');
  for (const [name, contents] of [['trailing', 'needle\n'], ['empty', ''], ['blank', 'needle\n\n']]) {
    const denylist = path.join(dir, `${name}.txt`);
    write(dir, `${name}.txt`, contents);
    const native = scan({ rootDir: dir, denylist });
    const fallback = scan({ rootDir: dir, denylist, env: { PATH: emptyPath, PATHEXT: '.EXE' } });
    assert.deepEqual(fallback.hits, native.hits, name);
  }
});

test('pure Node fallback applies ordered nested gitignore globs and negations', t => {
  const dir = fixture(t), emptyPath = fixture(t);
  write(dir, '.gitignore', '*.tmp\nlogs/**\n!logs/keep?.tmp\nnested/\n!nested/visible.md\n');
  write(dir, 'root.tmp', signatures[0]);
  write(dir, 'logs/drop.md', signatures[1]);
  write(dir, 'logs/keep1.tmp', signatures[2]);
  write(dir, 'nested/hidden.md', signatures[3]);
  write(dir, 'nested/visible.md', signatures[4]);
  const report = scan({ rootDir: dir, env: { PATH: emptyPath, PATHEXT: '.EXE' } });
  assert.deepEqual(report.hits.map(hit => hit.file), ['logs/keep1.tmp', 'nested/visible.md']);
});
