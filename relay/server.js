/* relay/server.js — StarNet Remote relay: the switchboard between a phone and a home station.

   WHAT IT IS. A station behind a home router can't accept connections, and a phone browser can only use
   WebCrypto on an HTTPS page. So both dial OUT to this relay over TLS, and it connects them. That's all.

   WHAT IT CAN'T DO. Everything a phone and a station say to each other is sealed end to end before it gets
   here (sidecar/remote/crypto.js). The relay sees who is connected to which station, message sizes and times,
   and the public halves of the handshake. It never holds a key and cannot read a transcript, a file, an
   approval or a reply. This file is public so anyone can check that.

   STATIONS prove who they are with their own key; there are no accounts in v1. On connect the relay sends a
   random challenge, the station signs it with its static P-256 key, and its routing id is the hash of that
   public key. Nobody can take over another station's id without its private key.

   PHONES connect to a station by that routing id. A phone that has paired carries a relay token; the station
   tells the relay which token hashes it accepts, so strangers can't even knock. An unpaired phone may only send
   a pairing request, a few times, and the station still checks the one-time code itself.

   WIRE (JSON text frames)
     station  <- { t:'challenge', nonce }
     station  -> { t:'auth', pub, sig }                 sig = ECDSA-P256-SHA256("starnet-relay/1|" + nonce), DER, base64url
     station  <- { t:'ready', rid }
     station  -> { t:'tokens', hashes:[b64u sha256] }   the paired phones' relay tokens (replaces the list)
     station  <- { t:'open', conn, paired }             a phone connected
     station  <- { t:'from', conn, msg }                what the phone sent
     station  -> { t:'to', conn, msg }                  what to send that phone
     station  -> { t:'kick', conn }                     drop a phone (revoked)
     station  <- { t:'gone', conn }                     the phone went away
     phone    /v1/phone?rid=<rid>&tok=<relay token>     then it just sends and receives `msg` objects
   Close codes to a phone: 4404 station offline · 4401 not paired · 4413 too large · 4429 too fast · 4410 replaced */
'use strict';

const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { makeWsServer } = require('./ws-lite.js');

const LABEL = 'starnet-relay/1';
const MAX_MSG = 1024 * 1024;            // a station frame (a 180 KB conversation, a 256 KB chunk, sealed + base64) stays well under this…
const MAX_PHONE_MSG = 256 * 1024;        // …a phone only ever sends small requests
const MAX_PREAUTH_MSG = 16 * 1024;     // …and before a station has proven its key it may send only a small auth message
const MAX_CONNS = 20000;                 // every socket this process holds
const MAX_PER_IP = 64;                   // sockets from one address (phones behind one carrier NAT share an address)
const TOKENS_WAIT_MS = 5000;             // how long a phone waits for a just-(re)connected station to say who is paired
const PING_MS = 25000;

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function ridOf(pubRaw) { return b64u(crypto.createHash('sha256').update(unb64u(pubRaw)).digest()).slice(0, 22); }
function tokenHash(tok) { return b64u(crypto.createHash('sha256').update(String(tok)).digest()); }

function importPub(raw) {
  const buf = unb64u(raw);
  if (buf.length !== 65 || buf[0] !== 4) throw new Error('bad key');
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(buf.subarray(1, 33)), y: b64u(buf.subarray(33, 65)) }, format: 'jwk' });
}

function makeLimiter(perSec, burst) {
  let tokens = burst, last = Date.now();
  return function take(n) {
    const t = Date.now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSec);
    last = t;
    if (tokens < (n || 1)) return false;
    tokens -= (n || 1);
    return true;
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

function makeRelay(opts) {
  const o = opts || {};
  const appDir = o.appDir ? path.resolve(o.appDir) : null;
  // single files served from outside appDir (run from the repo: the station's own VT323 font)
  const extra = new Map(Object.entries(o.extraFiles || {}).map(([k, v]) => [k, path.resolve(v)]));
  const log = o.log || ((m) => console.log('[relay] ' + m));
  const stations = new Map();   // rid -> { ws, tokens:Set, phones:Map(conn -> ws) }
  let nextConn = 1;
  const pairTries = new Map();  // ip -> { start, n }

  function send(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (_) {} }
  function ipOf(req) { return addrKey(String((req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim()); }

  // ONE bad request must never take the relay down: every station and phone rides this single process
  function serveStatic(req, res) {
    try { serveStaticInner(req, res); }
    catch (e) { log('bad request ' + String((e && e.message) || e).slice(0, 120)); try { if (!res.headersSent) res.writeHead(400); res.end(); } catch (_) {} }
  }
  function serveStaticInner(req, res) {
    const u = new URL(req.url, 'http://relay');
    if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, stations: stations.size })); }
    if (!appDir || req.method !== 'GET') { res.writeHead(404); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(u.pathname); } catch (_) { res.writeHead(400); return res.end(); }
    if (rel.indexOf('\0') >= 0 || rel.length > 200) { res.writeHead(400); return res.end(); }
    if (rel === '/' || rel === '') rel = '/index.html';
    let abs = extra.get(rel);
    if (!abs || !fs.existsSync(abs)) {
      abs = path.resolve(appDir, '.' + rel);
      if (abs !== appDir && abs.indexOf(appDir + path.sep) !== 0) { res.writeHead(403); return res.end(); }
    }
    let f = loadFile(abs);
    if (!f) { res.writeHead(404); return res.end(); }
    const ext = path.extname(abs).toLowerCase();
    // the service worker names its cache after the exact bytes of the app shell, so every deploy that changes the
    // app reaches every phone (and a phone never mixes an old script with new markup)
    if (rel === '/sw.js') f = withShellVersion(f);
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, { ETag: f.etag }); return res.end(); }
    const gz = f.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    {
      const buf = gz ? f.gz : f.buf;
      res.writeHead(200, {
        ETag: f.etag, Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // the page, its script and its styles are one version: always revalidated, so a phone never runs new markup
        // against an old script. Only the font and icons may be reused from cache.
        'Cache-Control': /\.(html|js|css|webmanifest)$/.test(ext) ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        // the page may talk only to this relay; no third-party script, frame or connection
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
      });
      res.end(buf);
    }
  }
  /* Static files are read once (re-read when they change on disk) and kept gzipped: the phone app is ~180 KB of
     text, about a quarter of that compressed, which is most of what a first open waits for. */
  const files = new Map();   // abs -> { mtime, size, buf, gz, etag }
  function compressible(abs) { return /\.(html|js|css|webmanifest|svg|json)$/i.test(abs); }
  function packed(buf, abs) {
    const gz = compressible(abs) ? zlib.gzipSync(buf, { level: 9 }) : null;
    return { buf, gz: gz && gz.length < buf.length ? gz : null, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 20) + '"' };
  }
  function loadFile(abs) {
    let st; try { st = fs.statSync(abs); } catch (_) { return null; }
    if (!st.isFile()) return null;
    const hit = files.get(abs);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
    let buf; try { buf = fs.readFileSync(abs); } catch (_) { return null; }
    const f = Object.assign({ mtime: st.mtimeMs, size: st.size }, packed(buf, abs));
    if (files.size > 64) files.clear();
    files.set(abs, f);
    return f;
  }
  const SHELL = ['index.html', 'app.css', 'app.js', 'store.js', 'phone-client.js', 'icon.svg', 'icon-180.png', 'manifest.webmanifest'];
  let swMemo = { key: '', f: null };
  function withShellVersion(f) {
    const h = crypto.createHash('sha256');
    for (const n of SHELL) { const g = loadFile(path.join(appDir, n)); if (g) h.update(g.etag); }
    const font = extra.get('/vt323.woff2') || path.join(appDir, 'vt323.woff2'), g = loadFile(font); if (g) h.update(g.etag);
    const key = f.etag + h.digest('base64');
    if (swMemo.key !== key) swMemo = { key, f: packed(Buffer.from(String(f.buf).split('%SHELL%').join(b64u(crypto.createHash('sha256').update(key).digest()).slice(0, 12))), 'sw.js') };
    return swMemo.f;
  }

  const server = http.createServer(serveStatic);
  const wss = makeWsServer({ maxPayload: MAX_MSG });
  const perIp = new Map();

  server.on('upgrade', (req, socket, head) => {
    let u;
    try { u = new URL(req.url, 'http://relay'); } catch (_) { socket.destroy(); return; }
    if (u.pathname !== '/v1/station' && u.pathname !== '/v1/phone') { socket.destroy(); return; }
    // one address (or everyone together) can only hold so many sockets: a flood of connections is refused at the door
    const ip = ipOf(req);
    if (wss.clients.size >= MAX_CONNS || (perIp.get(ip) || 0) >= (o.maxPerIp || MAX_PER_IP)) {
      try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); } catch (_) {}
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) || 0) + 1);
      ws.on('close', () => { const n = (perIp.get(ip) || 1) - 1; if (n > 0) perIp.set(ip, n); else perIp.delete(ip); });
      ws.maxPayload = u.pathname === '/v1/station' ? MAX_PREAUTH_MSG : MAX_PHONE_MSG;
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      if (u.pathname === '/v1/station') onStation(ws, req);
      else onPhone(ws, req, u);
    });
  });

  function onStation(ws, req) {
    const nonce = b64u(crypto.randomBytes(24));
    let rid = null;
    const limit = makeLimiter(200, 400);
    send(ws, { t: 'challenge', nonce });
    const authTimer = setTimeout(() => { if (!rid) ws.close(4401, 'auth timeout'); }, 10000);
    ws.on('message', (data, isBinary) => {
      if (isBinary || !limit()) return;
      let m; try { m = JSON.parse(String(data)); } catch (_) { return; }
      if (!rid) {
        if (!m || m.t !== 'auth') return ws.close(4401, 'auth first');
        try {
          const ok = crypto.verify('sha256', Buffer.from(LABEL + '|' + nonce), importPub(m.pub), unb64u(m.sig));
          if (!ok) return ws.close(4401, 'bad signature');
        } catch (_) { return ws.close(4401, 'bad auth'); }
        clearTimeout(authTimer);
        ws.maxPayload = MAX_MSG;   // a proven station may now send full-size frames
        rid = ridOf(m.pub);
        const prev = stations.get(rid);
        if (prev) { for (const p of prev.phones.values()) p.close(4404, 'station reconnecting'); prev.ws.close(4410, 'replaced'); }
        stations.set(rid, { ws, tokens: new Set(), tokensReady: false, waiting: [], phones: new Map() });
        send(ws, { t: 'ready', rid });
        log('station online ' + rid);
        return;
      }
      const st = stations.get(rid);
      if (!st || st.ws !== ws) return;
      if (m.t === 'ping') return send(ws, { t: 'pong' });
      if (m.t === 'tokens' && Array.isArray(m.hashes)) {
        st.tokens = new Set(m.hashes.slice(0, 64).map(String));
        if (!st.tokensReady) { st.tokensReady = true; const w = st.waiting.splice(0); for (const fn of w) { try { fn(); } catch (_) {} } }
        return;
      }
      if (m.t === 'to') { const p = st.phones.get(Number(m.conn)); if (p) send(p, m.msg); return; }
      if (m.t === 'kick') { const p = st.phones.get(Number(m.conn)); if (p) p.close(4401, 'revoked'); return; }
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!rid) return;
      const st = stations.get(rid);
      if (st && st.ws === ws) {
        for (const p of st.phones.values()) p.close(4404, 'station offline');
        stations.delete(rid);
        log('station offline ' + rid);
      }
    });
  }

  function allowPair(ip) {
    const t = Date.now();
    let e = pairTries.get(ip);
    if (!e || t - e.start > 10 * 60 * 1000) { e = { start: t, n: 0 }; pairTries.set(ip, e); }
    e.n += 1;
    if (pairTries.size > 4096) for (const [k, v] of pairTries) if (t - v.start > 10 * 60 * 1000) pairTries.delete(k);
    return e.n <= 10;
  }

  // A station that has just (re)connected has not sent its paired-phone list yet. A phone arriving in that moment
  // waits for it instead of being told "not paired" (which used to make a healthy phone think it was removed).
  function onPhone(ws, req, u) {
    const st = stations.get(String(u.searchParams.get('rid') || ''));
    if (!st) return ws.close(4404, 'station offline');
    if (st.tokensReady) return admitPhone(ws, req, u, st);
    const early = [];
    const hold = (data, isBinary) => { if (early.length < 8) early.push([data, isBinary]); };
    ws.on('message', hold);
    let done = false;
    const go = () => { if (done) return; done = true; clearTimeout(t); ws.off('message', hold); if (ws.readyState !== 1) return; admitPhone(ws, req, u, st, early); };
    const t = setTimeout(go, TOKENS_WAIT_MS);
    st.waiting.push(go);
  }
  function admitPhone(ws, req, u, st, early) {
    const rid = String(u.searchParams.get('rid') || '');
    const tok = String(u.searchParams.get('tok') || '');
    const paired = !!tok && st.tokens.has(tokenHash(tok));
    const conn = nextConn++;
    const limit = makeLimiter(30, 60);
    const ip = ipOf(req);
    st.phones.set(conn, ws);
    // th = which relay pass this connection showed, so the station can hold the phone to the device that pass belongs to
    send(st.ws, { t: 'open', conn, paired, th: paired ? tokenHash(tok) : '' });
    const onMsg = (data, isBinary) => {
      if (isBinary) return;
      if (data && data.length > MAX_PHONE_MSG) return ws.close(4413, 'too large');
      if (!limit()) return ws.close(4429, 'too fast');
      let msg; try { msg = JSON.parse(String(data)); } catch (_) { return; }
      if (!paired && !(msg && msg.t === 'pair')) return ws.close(4401, 'not paired');
      if (!paired && !allowPair(ip)) return ws.close(4429, 'too many pairing attempts');
      const cur = stations.get(rid);
      if (!cur || cur !== st) return ws.close(4404, 'station offline');
      send(st.ws, { t: 'from', conn, msg });
    };
    ws.on('message', onMsg);
    for (const [d, b] of early || []) onMsg(d, b);
    ws.on('close', () => {
      if (st.phones.get(conn) === ws) { st.phones.delete(conn); send(st.ws, { t: 'gone', conn }); }
    });
  }

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { try { ws.terminate(); } catch (_) {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, PING_MS);

  function listen(port, host) { return new Promise((resolve) => server.listen(port, host || '0.0.0.0', () => resolve(server.address().port))); }
  function close() {
    clearInterval(pinger);
    for (const ws of wss.clients) { try { ws.close(1012, 'relay restarting'); } catch (_) {} }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { listen, close, server, _stations: stations, _queuedBytes: () => wss.queuedBytes() };
}

/* addrKey(ip) — the key every per-address limit counts under. An IPv6 host usually holds a whole /64, so keyed on the
   full address one machine had effectively unlimited "addresses" (the per-address socket cap and pairing tries meant
   nothing over IPv6, and the relay has AAAA records). IPv6 counts by its /64; an IPv4-mapped IPv6 address by its IPv4. */
function addrKey(ip) {
  let s = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (v4) return v4[1];
  if (s.indexOf(':') < 0) return s;
  const parts = s.split('::');
  if (parts.length > 2) return s.toLowerCase();
  const head = parts[0] ? parts[0].split(':') : [], tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const full = parts.length === 2 ? head.concat(new Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail) : head;
  return full.slice(0, 4).map((h) => (h || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

module.exports = { makeRelay, ridOf, tokenHash, addrKey, LABEL, MAX_MSG, MAX_PREAUTH_MSG, MAX_PER_IP };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8799;
  // The phone app lives next to the relay (relay/app). The font is the station's own, served from the repo;
  // the Docker image copies it into ./app.
  const relay = makeRelay({
    appDir: process.env.APP_DIR || path.join(__dirname, 'app'),
    extraFiles: { '/vt323.woff2': path.join(__dirname, '..', 'frontend', 'assets', 'fonts', 'vt323.woff2') }
  });
  relay.listen(port).then((p) => console.log('[relay] listening on ' + p));
  // last line of defence: log and keep switching (a crash would drop every station and phone at once)
  process.on('uncaughtException', (e) => console.error('[relay] uncaught', e && e.stack || e));
  process.on('unhandledRejection', (e) => console.error('[relay] unhandled', e && e.stack || e));
  const stop = () => { relay.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
