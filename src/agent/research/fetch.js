'use strict';
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { USER_AGENT, assertOnline, problem, deadline, bounded } = require('./common');

function ipv6Words(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const index = value.lastIndexOf(':');
    const octets = value.slice(index + 1).split('.').map(Number);
    value = value.slice(0, index + 1) + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16);
  }
  const [left, right = ''] = value.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  return [...a, ...Array(8 - a.length - b.length).fill('0'), ...b].map(v => parseInt(v, 16));
}
function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (family !== 6 || address.includes('%')) return true;
  const w = ipv6Words(address);
  if (w.slice(0, 5).every(v => v === 0) && w[5] === 0xffff) {
    return isPrivateAddress(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
  }
  // Reject unspecified/compatible, ULA, link-local, multicast and transition tunnels.
  return w.slice(0, 6).every(v => v === 0) || (w[0] & 0xfe00) === 0xfc00 ||
    (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xff00) === 0xff00 ||
    w[0] === 0x2002 || (w[0] === 0x2001 && w[1] === 0) || (w[0] === 0x64 && w[1] === 0xff9b);
}
function checkedUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw problem('Invalid page URL.', 'url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw problem('Page URL must use HTTP(S) without credentials.', 'url');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'internal' || host.endsWith('.internal')) throw problem('Page host must be public.', 'ssrf');
  if (net.isIP(host) && isPrivateAddress(host)) throw problem('Page address is private or non-public.', 'ssrf');
  url.hash = '';
  return { url, host };
}
function lookupAll(host) {
  return new Promise((resolve, reject) => dns.lookup(host, { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
}
async function fetchPage(input, options = {}) {
  assertOnline();
  const scope = deadline(options.timeoutMs, options.signal);
  try {
    let target = input;
    for (let hop = 0; hop <= 3; hop++) {
      assertOnline();
      scope.signal.throwIfAborted();
      const { url, host } = checkedUrl(target);
      const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] :
        await bounded((options.lookup || lookupAll)(host, { all: true }), scope.signal);
      if (!addresses.length || addresses.some(a => isPrivateAddress(a.address) || net.isIP(a.address) !== a.family)) throw problem('DNS returned a private or non-public address.', 'ssrf');
      const checked = addresses[0];
      const response = await new Promise((resolve, reject) => {
        let request, responseStream, settled = false;
        const cleanup = () => scope.signal.removeEventListener('abort', abort);
        const finish = (error, value) => {
          if (settled) return;
          settled = true; cleanup();
          if (error) { responseStream?.destroy(); request?.destroy(); reject(error); } else resolve(value);
        };
        const abort = () => finish(scope.signal.reason);
        if (scope.signal.aborted) { abort(); return; }
        scope.signal.addEventListener('abort', abort, { once: true });
        try {
          request = (options.request || (url.protocol === 'https:' ? https.request : http.request))({
            protocol: url.protocol, hostname: host, port: url.port || undefined, path: url.pathname + url.search,
            method: 'GET', agent: false, servername: net.isIP(host) ? undefined : host,
            lookup: (_host, lookupOptions, callback) => lookupOptions?.all ? callback(null, [checked]) : callback(null, checked.address, checked.family),
            headers: { Host: url.host, 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Encoding': 'identity' }
          }, response => {
            responseStream = response;
            response.on('error', error => finish(error));
            const status = response.statusCode;
            if ([301, 302, 303, 307, 308].includes(status)) {
              const location = response.headers.location;
              response.destroy();
              if (!location || hop === 3) finish(problem('Page redirect limit exceeded or missing location.', 'redirect'));
              else { try { finish(null, { redirect: new URL(location, url).href }); } catch { finish(problem('Invalid page redirect.', 'redirect')); } }
              return;
            }
            const type = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            if (status < 200 || status >= 300) { finish(problem(`Page returned HTTP ${status}.`, 'http')); return; }
            if (!['text/html', 'application/xhtml+xml'].includes(type)) { finish(problem('Page response is not HTML.', 'content-type')); return; }
            if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity') { finish(problem('Compressed page response is not allowed.', 'encoding')); return; }
            if (Number(response.headers['content-length']) > 2 * 1024 * 1024) { finish(problem('Page exceeds raw byte limit.', 'size')); return; }
            const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers['content-type'])?.[1] || 'utf-8';
            let decoder;
            try { decoder = new TextDecoder(charset); } catch { finish(problem('Unsupported HTML character encoding.', 'encoding')); return; }
            let rawBytes = 0, textBytes = 0, html = '';
            const append = text => {
              textBytes += Buffer.byteLength(text);
              if (textBytes > 1024 * 1024) { finish(problem('Page exceeds decoded text byte limit.', 'size')); return false; }
              html += text; return true;
            };
            response.on('data', chunk => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              rawBytes += bytes.length;
              if (rawBytes > 2 * 1024 * 1024) { finish(problem('Page exceeds raw byte limit.', 'size')); return; }
              append(decoder.decode(bytes, { stream: true }));
            });
            response.on('aborted', () => finish(problem('Page response was incomplete.', 'aborted')));
            response.on('end', () => { if (!settled && append(decoder.decode())) finish(null, { finalUrl: url.href, html, contentType: type, bytes: rawBytes }); });
            response.on('close', () => { if (!settled) finish(problem('Page response closed before completion.', 'aborted')); });
          });
          request.on('error', error => finish(error));
          request.end();
        } catch (error) { finish(error); }
      });
      if (!response.redirect) return response;
      target = response.redirect;
    }
  } finally { scope.close(); }
}
module.exports = { fetchPage, isPrivateAddress, checkedUrl };
