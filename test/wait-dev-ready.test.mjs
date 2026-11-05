// node test/wait-dev-ready.test.mjs — waitDevReady reloads a page that loaded but is stuck, and never one still loading.
// A load outlasting the reload interval used to restart forever, which failed session-reliability on a busy CI runner.
import assert from 'node:assert/strict';
import { READY_EXPR, waitDevReady } from '../scripts/lib/seed.mjs';

const URL = 'http://127.0.0.1:1/';

// A navigation restarts the page: it needs `loadChecks` readiness checks to load, then is ready unless `stuckLoads` remain.
function fakePage({ loadChecks = 0, stuckLoads = 0, busyWhileLoading = false }) {
  let checks = 0, navigations = 0;
  const loading = () => checks <= loadChecks;
  return {
    cdp: { send: async (method) => { assert.equal(method, 'Page.navigate'); navigations++; checks = 0; } },
    evalJS: async (_cdp, expr) => {
      if (expr === READY_EXPR) { checks++; return !loading() && navigations >= stuckLoads; }
      assert.equal(expr, 'document.readyState');
      if (loading() && busyWhileLoading) throw new Error('CDP timeout: Runtime.evaluate');
      return loading() ? 'loading' : 'complete';
    },
    navigations: () => navigations
  };
}

async function run(pageOptions, waitOptions) {
  const page = fakePage(pageOptions);
  const ready = await waitDevReady(page.cdp, page.evalJS, { reloadEvery: 2, ...waitOptions });
  return { ready, navigations: page.navigations() };
}

const [slow, busy, stuck, noUrl] = await Promise.all([
  run({ loadChecks: 4 }, { url: URL, tries: 6 }),
  run({ loadChecks: 4, busyWhileLoading: true }, { url: URL, tries: 6 }),
  run({ stuckLoads: 1 }, { url: URL, tries: 6 }),
  run({ stuckLoads: 1 }, { tries: 3 })
]);

assert.deepEqual(slow, { ready: true, navigations: 0 }, 'a load slower than the reload interval is left to finish');
assert.deepEqual(busy, { ready: true, navigations: 0 }, 'a page too busy to answer counts as still loading');
assert.deepEqual(stuck, { ready: true, navigations: 1 }, 'a loaded page that is not ready gets reloaded');
assert.deepEqual(noUrl, { ready: false, navigations: 0 }, 'without a url nothing reloads and the wait reports failure');
console.log('wait-dev-ready: OK');
