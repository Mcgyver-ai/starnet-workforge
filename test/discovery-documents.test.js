'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const D = require('../sidecar/discovery.js');
const { makeDocumentDiscovery, POLICY } = require('../sidecar/discovery-documents.js');
const FailOpen = require('../sidecar/failopen.js');

(async () => {
  // real spelling: the adapter checks grants against the canonical path, and a TEMP like C:\WINDOWS\TEMP is really C:\Windows\Temp
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-doc-discovery-')));
  let granted = true;
  const adapter = makeDocumentDiscovery({ fsp, path, hash: s => crypto.createHash('sha256').update(s).digest('hex'), isBlessed: r => granted && r === root });
  const now = Date.now(), source = { id: 'client-update', root, enabled: true };
  try {
    fs.writeFileSync(path.join(root, 'meeting.md'), '# Meeting\nCompleted the client launch milestone.\n');
    fs.writeFileSync(path.join(root, 'plan.csv'), 'status,owner\nblocked,team\n');
    fs.writeFileSync(path.join(root, 'boring.txt'), 'Nothing relevant here.\n');
    fs.writeFileSync(path.join(root, 'passwords.md'), 'client status secret\n');
    fs.writeFileSync(path.join(root, 'config.md'), 'client progress\napi_key=not-a-real-key\n');
    fs.writeFileSync(path.join(root, 'binary.txt'), 'client\0progress');
    fs.writeFileSync(path.join(root, 'huge.md'), 'client progress\n' + 'a'.repeat(POLICY.maxFileBytes));
    fs.writeFileSync(path.join(root, 'old.md'), 'client progress from last month');
    fs.utimesSync(path.join(root, 'old.md'), new Date(now - 30 * 86400000), new Date(now - 30 * 86400000));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, '.hidden', 'notes.md'), 'client hidden');
    fs.mkdirSync(path.join(root, 'private'));
    fs.writeFileSync(path.join(root, 'private', 'notes.md'), 'client private');
    const scan = await adapter.scan(source, now + 1000);
    assert.equal(scan.ok, true);
    assert.equal(scan.findings.length, 1);
    const f = scan.findings[0];
    assert.deepEqual(f.evidence.map(e => e.path).sort(), ['meeting.md', 'plan.csv']);
    assert.equal(f.evidence.find(e => e.path === 'meeting.md').line, 2);
    assert.equal(f.evidence.find(e => e.path === 'meeting.md').quote, 'Completed the client launch milestone.');
    assert.ok(scan.bytes <= POLICY.maxTotalBytes);
    let state = D.stage(D.normalize({ sources: [source] }), f, { now });
    assert.equal(D.normalize(JSON.parse(JSON.stringify(state))).staged[0].evidence.length, 2);
    assert.equal(D.normalize(state).sources[0].root, root);
    state = D.dismiss(state, f.id, { now });
    const repeat = await adapter.scan(source, now + 2000);
    assert.equal(D.eligible(state, repeat.findings[0]), false, 'unchanged excerpts remain declined');
    fs.writeFileSync(path.join(root, 'meeting.md'), '# Meeting\nCompleted the client billing milestone.\n');
    const changed = await adapter.scan(source, now + 3000);
    assert.notEqual(changed.findings[0].fingerprint, f.fingerprint);
    assert.equal(D.eligible(state, changed.findings[0]), true, 'changed evidence may be proposed');
    granted = false;
    assert.equal((await adapter.scan(source, now)).ok, false);
    await assert.rejects(adapter.canonicalRoot(root), /Approve/);
    granted = true;
    assert.equal((await adapter.scan({ ...source, enabled: false }, now)).reason, 'source-paused');
    await assert.rejects(adapter.canonicalRoot('../outside'), /absolute/);
    // Junctions need no Windows developer-mode privileges; they must never be traversed.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-doc-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'escape.md'), 'client outside the selected source');
      fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal((await adapter.scan(source, now + 3000)).findings[0].evidence.some(e => e.path.includes('escape')), false);
      await assert.rejects(adapter.canonicalRoot(path.join(root, 'linked')), /link/);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    for (let i = 0; i < 70; i++) fs.writeFileSync(path.join(root, 'progress-' + i + '.md'), 'Completed client milestone ' + i + '\n');
    const bounded = await adapter.scan(source, now + 10000);
    assert.ok(bounded.files <= POLICY.maxFiles);
    assert.ok(bounded.bytes <= POLICY.maxTotalBytes);
    assert.ok(bounded.findings[0].evidence.length <= POLICY.maxEvidence);
    assert.equal(bounded.limited, true);
    const warnings = [], originalWarn = console.warn;
    const countBefore = FailOpen.counts();
    try {
      console.warn = (...args) => warnings.push(args.join(' '));
      const unavailableFile = makeDocumentDiscovery({ fsp: { ...fsp, open: async () => { throw new Error('PRIVATE-PATH-AND-SECRET'); } }, path,
        hash: s => crypto.createHash('sha256').update(s).digest('hex'), isBlessed: r => r === root });
      const missingFiles = await unavailableFile.scan(source, now + 10000);
      assert.equal(missingFiles.findings.length, 0);
      assert.equal(missingFiles.limited, true);
      const unavailableDirectory = makeDocumentDiscovery({ fsp: { ...fsp, opendir: async () => { throw new Error('PRIVATE-PATH-AND-SECRET'); } }, path,
        hash: s => crypto.createHash('sha256').update(s).digest('hex'), isBlessed: r => r === root });
      const missingDirectory = await unavailableDirectory.scan(source, now + 10000);
      assert.equal(missingDirectory.findings.length, 0);
      assert.equal(missingDirectory.limited, true);
      assert.ok(FailOpen.counts()['discovery.documents.file-read'] > (countBefore['discovery.documents.file-read'] || 0));
      assert.ok(FailOpen.counts()['discovery.documents.directory-read'] > (countBefore['discovery.documents.directory-read'] || 0));
      assert.ok(warnings.length);
      assert.equal(warnings.some(line => line.includes('PRIVATE-PATH-AND-SECRET') || line.includes(root)), false, 'failure diagnostics contain no source paths or OS error text');
    } finally { console.warn = originalWarn; }
    console.log('discovery-documents: extraction, freshness, durable shape, decline, bounds and junction checks passed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
