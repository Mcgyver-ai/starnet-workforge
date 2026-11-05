/* relay/ws-lite.js — a small, dependency-free WebSocket SERVER (RFC 6455), just what the relay needs.

   Clients are browsers and Node's built-in WebSocket, so this only has to speak the server side: the upgrade
   handshake, masked client frames (text, binary, continuation, ping, pong, close), unmasked server frames, a
   payload ceiling, and the close handshake. No extensions (permessage-deflate is declined by omission), no
   subprotocols. The surface mirrors the parts of the `ws` package the relay uses:

     const wss = makeWsServer({ maxPayload })
     wss.handleUpgrade(req, socket, head, (ws) => { ... })
     ws.on('message', (data:Buffer, isBinary) => {}) · ws.on('close', (code, reason) => {}) · ws.on('pong', () => {})
     ws.send(string|Buffer) · ws.ping() · ws.close(code, reason) · ws.terminate() · ws.readyState (1 open, 2 closing, 3 closed)
     wss.clients (Set) */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;   // FIN + opcode, server frames are never masked
  return Buffer.concat([head, payload]);
}

/* A flood of frames costs the relay memory and CPU whether or not they ever complete a message (empty continuation
   frames used to pile up forever: one connection could exhaust the process in about a second). So every connection
   has a FRAME budget checked in the parser itself, and a message may be split into at most MAX_FRAGS frames. */
const MAX_FRAGS = 256;
const FRAMES_PER_SEC = 1000, FRAME_BURST = 2000;
/* A peer that stops reading makes every frame sent to it wait in this process's memory, and anyone can make a station
   and a phone. One socket holds room for a few full frames (a relayed frame is at most 1 MB) and all sockets together
   stay well under the machine's memory (the per-socket cap alone doesn't: many sockets add up); over either, the
   connection being written to is dropped. Each write also counts WRITE_OVERHEAD: a waiting write costs Node about
   200 bytes beyond its data (measured), so a flood of tiny frames would otherwise use far more than the budget says. */
const MAX_QUEUED = 4 * 1024 * 1024, MAX_QUEUED_TOTAL = 256 * 1024 * 1024, WRITE_OVERHEAD = 512;

function makeWsServer(opts) {
  const maxPayload = (opts && opts.maxPayload) || 1024 * 1024;
  const maxQueued = (opts && opts.maxQueued) || MAX_QUEUED;
  const maxQueuedTotal = (opts && opts.maxQueuedTotal) || MAX_QUEUED_TOTAL;
  const clients = new Set();
  let totalQueued = 0;

  function handleUpgrade(req, socket, head, cb) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (req.method !== 'GET' || upgrade !== 'websocket' || !key || String(req.headers['sec-websocket-version']) !== '13') {
      try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (_) {}
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.setNoDelay(true);
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.maxPayload = maxPayload;   // the server may tighten this per connection (e.g. before a station proves its key)
    let frameTokens = FRAME_BURST, frameAt = Date.now();
    let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    let frags = [], fragOp = 0, fragLen = 0, closeSent = false, closeEmitted = false;

    // Ends the socket and emits 'close' exactly once, whichever way the connection ended.
    function destroy(code, reason) {
      if (ws.readyState !== 3) {
        ws.readyState = 3;
        clients.delete(ws);
        try { socket.destroy(); } catch (_) {}
      }
      if (!closeEmitted) { closeEmitted = true; ws.emit('close', code == null ? 1006 : code, reason || ''); }
    }
    let queued = 0;
    function writeCounted(out) {
      const cost = out.length + WRITE_OVERHEAD;
      if (queued + cost > maxQueued || totalQueued + cost > maxQueuedTotal) return destroy(1013, 'too slow');
      queued += cost; totalQueued += cost;
      // the callback also fires when the socket is destroyed with this write still waiting, so nothing stays counted
      const release = () => { queued -= cost; totalQueued -= cost; };
      try { socket.write(out, release); } catch (_) { release(); }
    }
    ws.send = (data) => {
      if (ws.readyState !== 1) return;
      const isBuf = Buffer.isBuffer(data);
      writeCounted(frame(isBuf ? 0x2 : 0x1, isBuf ? data : Buffer.from(String(data), 'utf8')));
    };
    ws.ping = () => { if (ws.readyState === 1) writeCounted(frame(0x9, Buffer.alloc(0))); };
    ws.close = (code, reason) => {
      if (ws.readyState !== 1) return;
      ws.readyState = 2;
      const r = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
      const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(Number(code) || 1000, 0); r.copy(p, 2);
      closeSent = true;
      try { socket.write(frame(0x8, p)); } catch (_) {}
      setTimeout(() => destroy(Number(code) || 1000, String(reason || '')), 2000).unref();   // the peer answers the close, or we drop the socket anyway
    };
    ws.terminate = () => destroy(1006, '');

    // A protocol error: send the close code, then stop reading. The rest of a bad frame is still arriving and
    // must not be parsed as new frames (it would look like garbage and cut the close short).
    let failed = false;
    function fail(code, reason) { failed = true; buf = Buffer.alloc(0); if (ws.readyState === 1) ws.close(code, reason); else destroy(code, reason); }

    function parse() {
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        if (b0 & 0x70) return fail(1002, 'reserved bits');
        if (!masked) return fail(1002, 'client frames must be masked');
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) {
          if (buf.length < 10) return;
          const big = buf.readBigUInt64BE(2);
          if (big > BigInt(ws.maxPayload)) return fail(1009, 'too large');
          len = Number(big); off = 10;
        }
        if (len > ws.maxPayload) return fail(1009, 'too large');
        // a data frame is checked WITH the fragments already held, before its bytes are buffered: checked alone, a
        // socket held a full message of fragments plus a full pending frame (~2x maxPayload each) (sweep 2026-10-02)
        if ((b0 & 0x0f) <= 0x2 && fragLen + len > ws.maxPayload) return fail(1009, 'too large');
        if (buf.length < off + 4 + len) return;
        const t = Date.now();
        frameTokens = Math.min(FRAME_BURST, frameTokens + ((t - frameAt) / 1000) * FRAMES_PER_SEC); frameAt = t;
        if (frameTokens < 1) return fail(1008, 'too many frames');
        frameTokens -= 1;
        const mask = buf.subarray(off, off + 4);
        const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + 4 + len);

        if (op >= 0x8) {   // control frames: never fragmented, ≤125 bytes
          if (!fin || len > 125) return fail(1002, 'bad control frame');
          if (op === 0x8) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
            const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
            if (!closeSent) { try { socket.write(frame(0x8, payload.subarray(0, 2))); } catch (_) {} }
            destroy(code, reason);
            return;
          }
          // a peer can send these forever without reading the replies, so they count against the budget too
          if (op === 0x9) { writeCounted(frame(0xA, payload)); if (ws.readyState === 3) return; continue; }
          if (op === 0xA) { ws.emit('pong'); continue; }
          return fail(1002, 'unknown control opcode');
        }
        if (op === 0x0) {
          if (!fragOp) return fail(1002, 'unexpected continuation');
        } else if (op === 0x1 || op === 0x2) {
          if (fragOp) return fail(1002, 'expected continuation');
          fragOp = op;
        } else return fail(1002, 'unknown opcode');
        fragLen += payload.length;
        if (fragLen > ws.maxPayload) return fail(1009, 'too large');
        if (frags.length >= MAX_FRAGS) return fail(1009, 'too many fragments');
        frags.push(payload);
        if (fin) {
          const data = frags.length === 1 ? frags[0] : Buffer.concat(frags);
          const isBinary = fragOp === 0x2;
          frags = []; fragOp = 0; fragLen = 0;
          if (ws.readyState === 1) ws.emit('message', data, isBinary);
        }
      }
    }

    socket.on('data', (d) => { if (failed) return; buf = buf.length ? Buffer.concat([buf, d]) : d; parse(); });
    // the HTTP server keeps upgraded sockets half-open: a peer that hangs up (FIN) only fires 'end', so end it here
    socket.on('end', () => destroy(1006, ''));
    socket.on('close', () => destroy(1006, ''));
    socket.on('error', () => destroy(1006, ''));
    clients.add(ws);
    cb(ws);
    if (buf.length) parse();
  }

  return { handleUpgrade, clients, queuedBytes: () => totalQueued };
}

module.exports = { makeWsServer, MAX_FRAGS, FRAMES_PER_SEC, FRAME_BURST, MAX_QUEUED, MAX_QUEUED_TOTAL };
