/* node test/runtime-knobs.test.js — the run-ceiling precedence rules (sidecar/runtime-knobs.js). Pure unit test,
   no server boot. These knobs gate spend and token ceilings, so a wrong precedence silently lifts a user's cap. */
'use strict';
const A = require('./_assert.js');
const K = require('../sidecar/runtime-knobs.js');

// env > saved > default
A.eq(K.resolveKnob('5000', 9000, 2000000), 5000, 'explicit env wins over a saved override');
A.eq(K.resolveKnob(null, 9000, 2000000), 9000, 'saved override wins over the default');
A.eq(K.resolveKnob(null, undefined, 2000000), 2000000, 'nothing set -> default');
A.eq(K.resolveKnob('0', 9000, 2000000), 0, 'env 0 is a real value (disables the ceiling), not "unset"');
A.eq(K.resolveKnob(null, 0, 2000000), 0, 'saved 0 is a real value, not "unset"');
A.eq(K.resolveKnob('12.9', null, 1), 12, 'env value is floored');

// a junk env value must not lock or replace the knob
for (const junk of ['', '   ', 'abc', '-1']) {
  A.eq(K.envSet(junk), false, 'env ' + JSON.stringify(junk) + ' does not count as set');
  A.eq(K.resolveKnob(junk, 9000, 2000000), 9000, 'env ' + JSON.stringify(junk) + ' falls through to the saved value');
}
A.eq(K.resolveKnob(null, -5, 2000000), 2000000, 'a negative saved value falls back to the default');

// parseKnobs: known keys only, non-negative finite numbers, floored
A.eq(K.parseKnobs({ knobs: { maxIters: 7.8, maxUnpricedTokens: -1, cronTickMs: 'x', maxConcurrentAgents: Infinity, bogus: 3 } }),
  { maxIters: 7 }, 'parseKnobs keeps only valid known keys');
A.eq(K.parseKnobs(null), {}, 'parseKnobs(null) -> {}');
A.eq(K.parseKnobs({ knobs: 'nope' }), {}, 'non-object knobs -> {}');

A.report('runtime-knobs.test');
