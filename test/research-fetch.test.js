'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { fetchPage, isPrivateAddress } = require('../src/agent/research/fetch');

function transport(responses, seen = []) {
  return (options, callback) => {
    seen.push(options);
    const request = new EventEmitter();
    request.destroy = error => { request.destroyed = true; if (error) queueMicrotask(() => request.emit('error', error)); };
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const next = responses.shift();
      const response = Readable.from(next.body || ['<article>Safe public HTML document.</article>']);
      response.statusCode = next.status || 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8', ...next.headers };
      callback(response);
    });
    return request;
  };
}
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
test('offline blocks before DNS or transport', async t => {
  t.mock.method(require('node:dns'), 'lookup', () => { throw Error('DNS called'); });
  const previous = process.env.DIAGIF_OFFLINE; process.env.DIAGIF_OFFLINE = '1';
  try { await assert.rejects(fetchPage('https://example.com'), { code: 'OFFLINE' }); }
  finally { if (previous === undefined) delete process.env.DIAGIF_OFFLINE; else process.env.DIAGIF_OFFLINE = previous; }
  assert.equal(require('node:dns').lookup.mock.callCount(), 0);
});
test('private IPv4, IPv6 and mapped representations are blocked', () => {
  for (const ip of ['0.1.2.3', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.31.1.2', '192.168.1.1', '100.64.0.1', '::', '::1', 'fc00::1', 'fdff::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:808:808']) assert.equal(isPrivateAddress(ip), false, ip);
});
test('rejects any private DNS answer and unsafe URLs before socket creation', async () => {
  const request = () => { throw Error('socket created'); };
  await assert.rejects(fetchPage('https://example.com', { lookup: async () => [...await lookup(), { address: '127.0.0.1', family: 4 }], request }), /private|public/i);
  for (const url of ['file:///etc/passwd', 'http://localhost', 'http://x.localhost', 'http://x.internal', 'https://u:p@example.com', 'http://2130706433']) await assert.rejects(fetchPage(url, { lookup, request })); // sanitize-allow: unsafe URL fixture
});
test('pins checked DNS address and sends only fixed, uncredentialed headers', async () => {
  const seen = [];
  const page = await fetchPage('https://example.com:8443/a', { lookup, request: transport([{}], seen), headers: { Authorization: 'secret', Cookie: 'secret' } });
  assert.match(page.html, /Safe public/);
  assert.equal(page.finalUrl, 'https://example.com:8443/a');
  assert.equal(seen[0].servername, 'example.com');
  assert.equal(seen[0].headers.Host, 'example.com:8443');
  assert.equal(seen[0].headers['Accept-Encoding'], 'identity');
  assert.equal(seen[0].headers.Authorization, undefined);
  seen[0].lookup('ignored', {}, (err, ip, family) => { assert.equal(err, null); assert.equal(ip, '93.184.216.34'); assert.equal(family, 4); });
});
test('redirect destination is rechecked and bounded to three hops', async () => {
  const seen = [];
  await assert.rejects(fetchPage('https://example.com', { lookup, request: transport([{ status: 301, headers: { location: 'http://169.254.169.254/latest' } }], seen) }), /private|public/i);
  assert.equal(seen.length, 1);
  await assert.rejects(fetchPage('https://example.com', { lookup, request: transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/again' } }))) }), /redirect/i);
});
test('rejects non-HTML, compressed, oversized and incomplete response bodies', async () => {
  for (const response of [
    { headers: { 'content-type': 'application/json' } },
    { headers: { 'content-encoding': 'gzip' } },
    { body: [Buffer.alloc(2 * 1024 * 1024 + 1)] },
    { body: ['a'.repeat(1024 * 1024 + 1)] },
    { status: 503 }
  ]) await assert.rejects(fetchPage('https://example.com', { lookup, request: transport([response]) }));
});
test('shared timeout includes DNS resolution', async () => {
  await assert.rejects(fetchPage('https://example.com', { timeoutMs: 20, lookup: () => new Promise(() => {}) }), /timeout|timed out/i);
});
test('abort before fetch creates no DNS work and never opens a socket', async () => {
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  let calls = 0;
  await assert.rejects(fetchPage('https://example.com', { signal: controller.signal,
    lookup: async () => { calls++; return lookup(); }, request: () => { calls++; } }), /cancelled/);
  assert.equal(calls, 0);
});
test('three public redirects succeed and pin each hop independently', async () => {
  const seen = [], hosts = [];
  const result = await fetchPage('https://example.com/start', {
    lookup: async host => { hosts.push(host); return lookup(); },
    request: transport([
      { status: 301, headers: { location: '/second' } },
      { status: 302, headers: { location: 'https://other.example/third' } },
      { status: 307, headers: { location: '/final' } }, {}
    ], seen)
  });
  assert.equal(seen.length, 4);
  assert.deepEqual(hosts, ['example.com', 'example.com', 'other.example', 'other.example']);
  assert.equal(result.finalUrl, 'https://other.example/final');
  assert.equal(seen[2].servername, 'other.example');
  seen[0].lookup('ignored', { all: true }, (err, ips) => { assert.equal(err, null); assert.deepEqual(ips, [{ address: '93.184.216.34', family: 4 }]); });
});
test('aborted and stalled HTML bodies fail instead of producing partial evidence', async () => {
  for (const stall of [false, true]) {
    let stream;
    const request = (_options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => { stream?.destroy(); };
      req.end = () => queueMicrotask(() => {
        stream = new Readable({ read() {} }); stream.statusCode = 200; stream.headers = { 'content-type': 'text/html' };
        callback(stream); stream.push('<article>Partial evidence');
        if (!stall) stream.emit('aborted');
      });
      return req;
    };
    await assert.rejects(fetchPage('https://example.com', { lookup, request, timeoutMs: 20 }), /incomplete|timed out/);
    assert.equal(stream.destroyed, true);
  }
});
