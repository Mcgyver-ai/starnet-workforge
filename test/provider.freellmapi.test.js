/* node test/provider.freellmapi.test.js - the FreeLLMAPI gateway profile, and the openai-compatible guard for a gateway
   that answers its web page (200 text/html) instead of the API. */
'use strict';
const A = require('./_assert.js');
const registry = require('../sidecar/providers/registry.js');
const factory = require('../sidecar/providers/factory.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

async function collect(p, req) { const out = []; for await (const ev of p.stream(req)) out.push(ev); return out; }

(async () => {
  const prof = registry.getProviderProfile('free-llm-api');
  A.eq([prof && prof.id, prof && prof.baseUrl, prof && prof.keyRequired], ['freellmapi', 'http://127.0.0.1:31415/v1', true], 'the alias resolves to a keyed profile on the gateway\'s /v1');

  const seen = [];
  const fetch = async (url, init) => { seen.push({ url, auth: init && init.headers && init.headers.Authorization }); return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({ data: [{ id: 'auto' }] }) }; };
  const models = await factory.selectProvider({ provider: 'freellmapi', fetch, key: 'k' }).listModels();
  A.ok(models.some(m => m.id === 'auto'), 'the factory lists the gateway catalog');
  A.eq([seen[0].url, seen[0].auth], ['http://127.0.0.1:31415/v1/models', 'Bearer k'], 'the catalog is read from /v1/models with the key');

  const html = async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/html; charset=utf-8']]), body: {} });
  const p = makeOpenAICompatibleProvider({ fetch: html, baseUrl: 'http://127.0.0.1:31415', key: 'k', label: 'FreeLLMAPI' });
  let err = null; try { await collect(p, { model: 'm', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
  A.ok(err && /web page/.test(err.message) && /31415\/v1/.test(err.message), 'a 200 HTML page instead of the API names the missing /v1');

  const pv1 = makeOpenAICompatibleProvider({ fetch: html, baseUrl: 'http://127.0.0.1:31415/v1', key: 'k', label: 'FreeLLMAPI' });
  err = null; try { await collect(pv1, { model: 'm', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
  A.ok(err && /web page/.test(err.message) && !/\/v1\/v1/.test(err.message), 'a base URL already on /v1 is not told to add another /v1');

  // The gateway serves many vendors' ids as vendor/model: a refused one must not send the user to STARNET/OPENROUTER (#126).
  const refused = async () => ({ ok: false, status: 404, headers: new Map([['content-type', 'application/json']]),
    text: async () => '{"error":{"message":"model google/gemini-x not found"}}', json: async () => ({ error: { message: 'model google/gemini-x not found' } }) });
  const gw = factory.selectProvider({ provider: 'freellmapi', fetch: refused, key: 'k' });
  err = null; try { await collect(gw, { model: 'google/gemini-x', messages: [{ role: 'user', content: 'x' }] }); } catch (e) { err = e; }
  A.ok(err && /404/.test(err.message), 'a refused model surfaces the 404');
  A.ok(err && !/routed-catalog|Switch the provider/.test(err.message), 'a gateway\'s vendor/model id gets no switch-provider hint');

  A.report('provider.freellmapi.test');
})().catch(e => { console.log('FAIL: provider.freellmapi.test threw -- ' + (e && e.stack || e)); process.exit(1); });
