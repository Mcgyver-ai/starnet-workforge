/* sidecar/providers/antigravity-cli.js — Google's Antigravity CLI (`agy`) as a brain, on the user's own sign-in.

   WHY THE CLI AND NOT THE OAUTH TOKEN. Antigravity's subscription models (Gemini, plus the Claude and GPT-OSS models
   Google serves inside it) are reachable over HTTP with the token the Antigravity app mints, and third-party tools
   that lifted that token got their users' Google accounts suspended for a ToS violation (Google AI Developers Forum,
   2026: "This service has been disabled in this account for violation of Terms of Service"). Headless print mode
   (`agy -p`) is Google's documented way to drive the agent from scripts, and StarNet never reads, stores or forwards
   the credential: the CLI keeps its own sign-in, exactly like the Claude CLI provider (claude-cli.js).

   ONE TURN = ONE CHILD. Each turn spawns `agy --input-format stream-json --output-format stream-json -p` with the
   whole transcript as ONE stream-json user line on stdin (antigravity.google/docs/cli/headless). Output events:
     {"event":"init", "conversation_id", "init":{cwd, tools, permission_mode, model?}}
     {"event":"step_update", "step_update":{step_type, state, text_delta?, tool_name?, tool_info?, usage?}}
     {"event":"result", "result":{status, response, error?, usage:{input_tokens, output_tokens, thinking_tokens,
       cache_read_tokens, total_tokens}}}
   Text deltas of agent_response steps stream as text; exactly one 'done' follows the result line.

   CAPABILITY BOUNDARY. agy is an agent with its own tools (read_file, write_file, command, read_url, MCP) and, unlike
   `claude`, has no flag that switches them all off and no system-prompt override. So:
     - the child runs in a fresh EMPTY temp folder, with --sandbox, and never with --dangerously-skip-permissions
       (headless mode soft-denies anything that would ask for approval);
     - StarNet's own tools are described in the prompt and requested as <function_calls> text blocks, parsed by the
       Claude CLI adapter's reader, so loop.js executes them through the same capability gate and consent broker;
     - FAIL CLOSED: the moment agy starts one of its OWN tool steps the child's process tree is killed and the turn
       fails with native_tool_blocked. A brain that ran something StarNet did not gate is never reported as fine.

   COST TRUTH. agy's result line carries real token counts but no money figure. A Google sign-in (auth.type
   oauth-personal / oauth-business, the default) bills nothing per call: booked $0 with the real tokens, flagged
   `subscription` so the loop's subscription-token ceiling counts it. A Gemini API key or Agent Platform sign-in IS
   billed, and nothing here can price it, so those turns go out unpriced (the loop's unpriced-token ceiling applies).

   MODELS. `agy models` is the catalog: its slugs are display strings ('Gemini 3.1 Pro (High)') that change with the
   account's plan, so nothing is hardcoded. An unknown --model fails the run (agy does not fall back headless).

   makeAntigravityCliProvider({ spawn?, bin?, env?, platform?, fs?, os?, idleMs?, modelsTimeoutMs? })
     -> { stream, listModels, contextLimit, priceOf, supportsTools, supportsImages, reasoningEfforts } */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./provider.js'), require('./claude-cli.js'));
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).antigravityCli = factory(root.SK.providers.provider, root.SK.providers.claudeCli); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (provider, claudeCli) {
  'use strict';

  const timeouts = provider.timeouts;
  const { note: failNote } = (typeof require === 'function') ? require('../failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  const { buildPrompt, makeCallSplitter, parseCall, looseCall, invokeCall } = claudeCli._internals;
  const NAME = 'Antigravity CLI';
  // agy does not publish context windows; 200k is the smallest window among the families it serves (Claude), so
  // compaction never trusts a window the model behind the slug might not have.
  const DEFAULT_CONTEXT = 200000;
  const EFFORTS = ['low', 'medium', 'high'];   // headless --effort (docs/cli/headless)
  const CALL_OPEN = '<tool_call>', CALL_CLOSE = '</tool_call>';
  const IMAGE_NOTE = '[image omitted — the Antigravity CLI takes text input only]';
  // The empty working folder and the instructions below are the soft boundary; the native-tool kill is the hard one.
  const GROUND_RULES = [
    '# Session rules',
    'You are the reasoning engine inside StarNet. Do NOT use any of your own built-in tools: no file reads or writes,',
    'no terminal commands, no browsing or URL fetches, no MCP servers, no subagents. The working folder is empty on',
    'purpose. Every action goes through the StarNet tool format described in the instructions, and nowhere else.'
  ].join('\n');

  // Images become a note: agy's stream-json input accepts text blocks only.
  function textOnly(messages) {
    return (Array.isArray(messages) ? messages : []).map(m => {
      if (!m || !Array.isArray(m.content)) return m;
      return Object.assign({}, m, { content: m.content.map(p => (p && (p.type === 'image_url' || p.type === 'image')) ? { type: 'text', text: IMAGE_NOTE } : p) });
    });
  }
  // The transcript the Claude CLI adapter renders (its tool protocol, inert tags, host-note joins), flattened into the
  // single user message agy takes: agy keeps its own system prompt, so StarNet's rides at the top of the turn.
  function composePrompt(messages, tools) {
    const built = buildPrompt(textOnly(messages), tools);
    const transcript = built.blocks.filter(b => b && b.type === 'text').map(b => b.text).join('\n\n');
    return '<starnet_instructions>\n' + String(built.system || '').trim() + '\n\n' + GROUND_RULES + '\n</starnet_instructions>\n\n' + transcript;
  }
  // `{"event":"user","message":{"content":…}}` — the documented stdin line; closing stdin ends the session (exit 0).
  function inputLine(text) {
    return JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text }] } }) + '\n';
  }

  const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g;
  /* `agy models` prints one slug per line. Decorations (bullets, a current-model marker, a header ending in ':') are
     dropped; a slug's own parentheses ('Gemini 3.1 Pro (High)') are part of it and stay. */
  function parseModels(stdout) {
    const out = [], seen = new Set();
    for (let line of String(stdout || '').replace(ANSI_RE, '').split(/\r?\n/)) {
      line = line.replace(/^\s*(?:[-*•>›✓✔●○]\s+|\d+[.)]\s+)/, '').replace(/\s+\((?:default|current|selected|active)\)\s*$/i, '').trim();
      if (!line || /:$/.test(line) || /^(?:available models|models|usage\b)/i.test(line) || line.length > 120) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }

  // How the CLI is signed in, read from its own settings file (config, never a secret). '' = not stated.
  function authTypeOf(fs, path, env) {
    const home = String(env.HOME || env.USERPROFILE || '');
    if (!home) return '';
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'));
      const t = (j && j.auth && typeof j.auth === 'object' && j.auth.type) || (j && j['auth.type']) || '';
      return String(t || '').trim().toLowerCase();
    } catch (_) { return ''; }
  }
  function isSubscription(authType, env) {
    if (/^oauth-/.test(authType)) return true;
    // no auth.type written: the CLI's default is the Google sign-in, unless a Gemini key is in reach of the child
    return !authType && !String(env.GEMINI_API_KEY || '').trim();
  }

  function makeHost(opts) {
    const childEnvLib = require('../child-env.js');
    const spawn = opts.spawn || childEnvLib.guardChildProcess(require('node:child_process')).spawn;
    const fs = opts.fs || require('fs');
    const os = opts.os || require('os');
    const path = require('path');
    const env = opts.env || process.env;
    const platform = opts.platform || process.platform;
    const isFile = p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

    // the official installers drop agy in ~/.local/bin (macOS/Linux) or %LOCALAPPDATA%\agy\bin (Windows); a Finder-
    // launched app has a bare PATH, so those homes (and Homebrew's) are looked at directly too
    function command() {
      const configured = String(opts.bin || env.STARNET_AGY_BIN || '').trim();
      if (configured) return configured;
      const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
      const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
      if (platform === 'win32' && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
      if (platform !== 'win32') {
        if (env.HOME) dirs.push(path.join(env.HOME, '.local', 'bin'));
        dirs.push('/opt/homebrew/bin', '/usr/local/bin');
      }
      for (const dir of dirs) for (const ext of exts) { const p = path.join(dir, 'agy' + ext); if (isFile(p)) return p; }
      return '';
    }
    function notInstalled() {
      const e = new Error('The Antigravity CLI (agy) is not installed on this computer — install it from antigravity.google, run `agy` once in a terminal to sign in, then retry');
      e.code = 'provider_not_configured';
      return e;
    }
    function notSignedIn(detail) {
      const e = new Error('The Antigravity CLI is not signed in' + (detail ? ' (' + String(detail).slice(0, 200) + ')' : '') + ' — run `agy` once in a terminal and sign in with Google, then retry');
      e.code = 'provider_not_configured'; e.status = 401;
      return e;
    }
    function childEnv() { return childEnvLib.stationChildEnv(env); }
    function killTree(child) {
      if (!child || child.exitCode != null || child.signalCode != null) return;
      try {
        if (platform === 'win32' && child.pid) {
          const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          if (k && typeof k.on === 'function') k.on('error', () => { try { child.kill(); } catch (e) { failNote('agy.kill', e); } });
        } else child.kill('SIGTERM');
      } catch (e) { failNote('agy.killtree', e); try { child.kill(); } catch (e2) { failNote('agy.kill', e2); } }
    }
    // A fresh empty folder per child: agy's own file tools find nothing of the user's to touch.
    function scratchDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-agy-')); }
    function dropDir(dir) {
      if (!dir) return;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { failNote('agy.scratch.rm', e); }
    }
    return { spawn, fs, os, path, env, platform, command, notInstalled, notSignedIn, childEnv, killTree, scratchDir, dropDir };
  }

  const AUTH_RE = /auth(?:entication|orization)? required|not (?:signed|logged) in|sign[- ]?in required|unauthenticated|login required|401/i;
  const QUOTA_RE = /quota|rate.?limit|usage limit|resource.?exhausted|out of (?:ai )?credits|insufficient credits|429/i;
  function failureError(host, message) {
    const msg = String(message || '').trim();
    if (AUTH_RE.test(msg)) return host.notSignedIn(msg);
    // a spent plan window is quota_exhausted (errorClass): rotate or fall back instead of retrying this sign-in
    if (QUOTA_RE.test(msg)) { const e = new Error(NAME + ' usage limit reached: ' + msg.slice(0, 300)); e.status = 429; e.code = 'usage_limit_reached'; return e; }
    if (/unknown model|invalid model|model .*not (?:found|available)/i.test(msg)) {
      const e = new Error(NAME + ' does not offer that model on this account (' + msg.slice(0, 200) + ') — pick one `agy models` lists');
      e.status = 400; e.code = 'model_not_found';
      return e;
    }
    return new Error(NAME + ' error: ' + (msg || 'unknown error').slice(0, 400));
  }
  function nativeToolError(name) {
    const e = new Error(NAME + ' tried to run its own tool' + (name ? ' (' + String(name).slice(0, 80) + ')' : '') + ' — StarNet stopped the turn, because only StarNet\'s gated tools may run. Retry, or pick another model.');
    e.code = 'native_tool_blocked';
    return e;
  }

  function makeAntigravityCliProvider(opts) {
    opts = opts || {};
    const host = makeHost(opts);
    const { spawn, fs, path, env, command, notInstalled, childEnv, killTree } = host;
    const idTag = require('crypto').randomBytes(4).toString('hex');   // unique call ids across adapters (see claude-cli)
    let seq = 0;
    const modelsTimeoutMs = Number(opts.modelsTimeoutMs) > 0 ? Number(opts.modelsTimeoutMs) : 20000;

    // `agy models`: the live catalog for this sign-in, and the only proof that the sign-in works.
    function runModels() {
      return new Promise((resolve, reject) => {
        const bin = command();
        if (!bin) return reject(notInstalled());
        let out = '', err = '', settled = false, child, cwd = '';
        const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); host.dropDir(cwd); fn(v); };
        // issue google-antigravity/antigravity-cli#318: agy can hang without a TTY — never wait on it forever
        const timer = setTimeout(() => { killTree(child); finish(reject, new Error(NAME + ' did not answer `agy models` within ' + Math.round(modelsTimeoutMs / 1000) + 's — run `agy` once in a terminal to finish its setup, then retry')); }, modelsTimeoutMs);
        try {
          cwd = host.scratchDir();
          child = spawn(bin, ['models'], { env: childEnv(), cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (_) { return finish(reject, notInstalled()); }
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.on('error', e => finish(reject, (e && e.code === 'ENOENT') ? notInstalled() : e));
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err = (err + d).slice(-4000); });
        child.on('close', code => {
          const ids = parseModels(out);
          if (code === 0 && ids.length) return finish(resolve, ids);
          const why = (err.trim() || out.trim()).split(/\r?\n/).slice(-3).join(' ');
          finish(reject, AUTH_RE.test(why) ? host.notSignedIn(why) : new Error(NAME + ' listed no models' + (why ? ': ' + why.slice(0, 300) : ' (exit ' + code + ')')));
        });
      });
    }
    async function listModels() {
      const ids = await runModels();
      return ids.map(id => ({
        id, name: id, context_length: DEFAULT_CONTEXT, max_completion_tokens: null, pricing: null,
        supportsTools: true, supportsReasoning: true, supported_parameters: ['tools', 'reasoning'], reasoningEfforts: EFFORTS.slice()
      }));
    }

    const effortOf = req => { const e = String(req.reasoningEffort || '').trim().toLowerCase(); return EFFORTS.indexOf(e) >= 0 ? e : ''; };
    function cliArgs(req) {
      // -p last: it may take a value, and with stream-json input the prompt is on stdin
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox', '--disable-slash-commands'];
      if (req.model) args.push('--model', String(req.model));
      const effort = effortOf(req);
      if (effort) args.push('--effort', effort);
      args.push('-p');
      return args;
    }

    async function* stream(req) {
      req = req || {};
      if (req.signal && req.signal.aborted) return;
      const bin = command();
      if (!bin) throw notInstalled();
      const signal = req.signal;
      const turn = ++seq;
      const subscription = isSubscription(authTypeOf(fs, path, env), env);
      const hasTools = Array.isArray(req.tools) && req.tools.length > 0;
      const splitter = makeCallSplitter({ enabled: hasTools });
      const props = {};
      for (const tl of (hasTools ? req.tools : [])) { const fn = tl && tl.function; if (fn && fn.name) props[String(fn.name)] = (fn.parameters && fn.parameters.properties) || {}; }
      const callId = i => 'call_agy_' + idTag + '_' + turn + '_' + i;

      const queue = [];
      let wake = null, closed = false, failure = null, exitCode = null, stderr = '', lineBuf = '', child = null, cwd = '';
      const push = item => { queue.push(item); if (wake) { const w = wake; wake = null; w(); } };
      const idle = opts.idleMs || timeouts.idleMs();
      let idleTimer = null, finished = false;
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (finished) return;
        idleTimer = setTimeout(() => { failure = timeouts.timeoutError(idle, 'idle'); killTree(child); push(null); }, idle);
      };
      const onAbort = () => { killTree(child); push(null); };
      try {
        cwd = host.scratchDir();
        child = spawn(bin, cliArgs(req), { env: childEnv(), cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (_) { host.dropDir(cwd); throw notInstalled(); }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      armIdle();
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.on('error', e => { failure = (e && e.code === 'ENOENT') ? notInstalled() : e; closed = true; push(null); });
      child.stdout.on('data', d => {
        armIdle();
        lineBuf += d;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) { const line = lineBuf.slice(0, nl).trim(); lineBuf = lineBuf.slice(nl + 1); if (line) push(line); }
      });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
      child.on('close', code => { exitCode = code; if (lineBuf.trim()) push(lineBuf.trim()); lineBuf = ''; closed = true; push(null); });
      child.stdin.on('error', e => failNote('agy.stdin', e));
      try { child.stdin.end(inputLine(composePrompt(req.messages, req.tools))); } catch (e) { failNote('agy.stdin', e); }

      let open = null, callIndex = 0, sawText = false, result = null, blockDone = false, lastUsage = null, outChars = 0;
      function emitSplit(part, out) {
        for (const it of part.items) {
          if (it.text != null) { if (it.text) { sawText = true; out.push({ type: 'text', delta: it.text }); } continue; }
          if (it.start) {
            open = { index: callIndex++, name: it.start };
            out.push({ type: 'tool_start', index: open.index, id: callId(open.index), name: it.start });
            continue;
          }
          const was = open; open = null;
          const call = it.kind === 'invoke' ? invokeCall(was ? was.name : '', it.body, props[was ? was.name : ''], it.closed)
            : (parseCall(it.body) || (was ? looseCall(it.body, was.name) : null));
          if (!call) { sawText = true; out.push({ type: 'text', delta: CALL_OPEN + it.body + (it.closed ? CALL_CLOSE : '') }); continue; }
          const index = was ? was.index : callIndex++;
          if (!was) out.push({ type: 'tool_start', index, id: callId(index), name: call.name });
          out.push({ type: 'tool_args', index, chunk: call.args });
          out.push({ type: 'tool_done', index });
        }
        return out;
      }
      function usageChunk(u) {
        u = u || {};
        const input = Number(u.input_tokens) || 0, cacheRead = Number(u.cache_read_tokens) || 0;
        // a turn stopped at its call block may have no count yet: floor it at ~4 characters a token (see claude-cli STOP)
        const output = Math.max(Number(u.output_tokens) || 0, Math.ceil(outChars / 4));
        return {
          type: 'usage',
          usage: {
            prompt_tokens: input,   // agy's input_tokens already include the cache reads (total = input + output)
            completion_tokens: output,
            total_tokens: input + output,
            prompt_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: 0 },
            reasoning_tokens: Number(u.thinking_tokens) || 0,
            cost: subscription ? 0 : undefined,
            subscription: subscription || undefined
          }
        };
      }
      // one stdout line -> the harness events it yields; throws native_tool_blocked (fail closed)
      function onLine(j) {
        const out = [];
        if (!j || typeof j !== 'object') return out;
        if (j.event === 'step_update') {
          const s = j.step_update || {};
          if (s.usage) lastUsage = s.usage;
          if (s.step_type === 'tool' || s.tool_name || s.subagent_info) throw nativeToolError(s.tool_name || (s.tool_info && s.tool_info.name));
          if (s.step_type === 'agent_response' && typeof s.text_delta === 'string' && s.text_delta) {
            outChars += s.text_delta.length;
            const part = splitter.push(s.text_delta);
            emitSplit(part, out);
            if (part.stop) blockDone = true;
          }
        } else if (j.event === 'result') result = j.result || {};
        return out;
      }

      let endedOnResult = false;
      try {
        if (subscription) yield { type: 'billing', perCall: false };
        for (;;) {
          if (signal && signal.aborted) return;
          if (!queue.length) {
            if (closed) break;
            await new Promise(r => { wake = r; });
            continue;
          }
          const line = queue.shift();
          if (line == null) {
            if (signal && signal.aborted) return;
            if (failure) throw failure;
            if (closed) break;
            continue;
          }
          let j;
          try { j = JSON.parse(line); } catch (_) { continue; }
          for (const ev of onLine(j)) yield ev;
          // the call block is over: anything agy writes after it is a guess at results it has not seen (see claude-cli STOP)
          if (blockDone) break;
          if (result) { endedOnResult = true; break; }
        }
        if (signal && signal.aborted) return;
        if (blockDone) {
          yield usageChunk(lastUsage);
          yield { type: 'done', finishReason: 'tool_calls', truncated: false };
          return;
        }
        if (!result) {
          const tail = String(stderr || '').trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
          if (AUTH_RE.test(tail)) throw host.notSignedIn(tail);
          throw new Error(NAME + ' exited with code ' + exitCode + ' before answering' + (tail ? ': ' + tail : ''));
        }
        const status = String(result.status || '').toUpperCase();
        if (status !== 'SUCCESS') {
          if (result.usage) yield usageChunk(result.usage);
          const err = result.error;
          throw failureError(host, (err && typeof err === 'object' ? (err.message || JSON.stringify(err)) : err) || status || stderr);
        }
        if (!sawText && callIndex === 0 && typeof result.response === 'string') { const part = splitter.push(result.response); yield* emitSplit(part, []); }
        yield* emitSplit(splitter.end(), []);
        yield usageChunk(result.usage || lastUsage);
        yield { type: 'done', finishReason: callIndex > 0 ? 'tool_calls' : 'stop', truncated: false };
      } finally {
        finished = true;
        if (idleTimer) clearTimeout(idleTimer);
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        // stdin is closed, so a child that answered exits by itself; give it a moment, then take its tree with the folder
        if (!closed && endedOnResult && !(signal && signal.aborted)) {
          const late = setTimeout(() => { if (!closed) killTree(child); host.dropDir(cwd); }, 3000);
          if (late && typeof late.unref === 'function') late.unref();
        } else { if (!closed) killTree(child); host.dropDir(cwd); }
      }
    }

    return {
      stream,
      listModels,
      contextLimit() { return DEFAULT_CONTEXT; },
      priceOf() { return null; },   // no list-rate table: subscription turns are $0, keyed turns stay honestly unpriced
      supportsTools() { return true; },
      supportsImages() { return false; },
      reasoningEfforts() { return EFFORTS.slice(); }
    };
  }

  return { makeAntigravityCliProvider, _internals: { composePrompt, inputLine, parseModels, isSubscription, failureError, EFFORTS } };
});
