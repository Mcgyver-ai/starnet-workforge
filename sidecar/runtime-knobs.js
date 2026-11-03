/* sidecar/runtime-knobs.js — the PURE precedence rules for the runtime knobs (spend/token/iteration ceilings),
   factored out of index.js so they are unit-testable (index.js self-boots a server and cannot be required by a
   test). index.js keeps the I/O: reading runtime-knobs.json (+ .bak) and the ENV lookup.
   Precedence: an explicit env value > a saved override > the built-in default. No clock, rng or fs here. */
'use strict';

const SAVED_KEYS = ['maxIters', 'maxConcurrentAgents', 'consentTimeoutMs', 'cronTickMs', 'maxSubscriptionTokens', 'maxUnpricedTokens'];

// the saved-knobs file envelope -> { key: non-negative integer } for known keys only; anything else is dropped
function parseKnobs(raw) {
  const k = (raw && typeof raw === 'object' && raw.knobs && typeof raw.knobs === 'object') ? raw.knobs : {};
  const out = {};
  for (const key of SAVED_KEYS) {
    const v = k[key];
    if (typeof v === 'number' && isFinite(v) && v >= 0) out[key] = Math.floor(v);
  }
  return out;
}

// is this raw env string a usable knob value? (blank, negative or non-numeric = "not set", so it cannot lock a knob)
function envSet(e) { return e != null && String(e).trim() !== '' && Number(e) >= 0; }

function resolveKnob(envValue, savedValue, def) {
  if (envSet(envValue)) return Math.floor(Number(envValue));
  return (typeof savedValue === 'number' && savedValue >= 0) ? savedValue : def;
}

module.exports = { parseKnobs, envSet, resolveKnob, SAVED_KEYS };
