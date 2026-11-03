'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { makeProjectDiscovery } = require('../sidecar/project-discovery.js');

(async () => {
  // real spelling: discovery reports canonical paths, and a TEMP like C:\WINDOWS\TEMP is really C:\Windows\Temp
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-project-discovery-')));
  try {
    const shelf = path.join(root, 'Projects');
    const nodeProject = path.join(shelf, 'alpha');
    const rustProject = path.join(shelf, 'group', 'beta');
    const ignored = path.join(shelf, 'node_modules', 'not-a-project');
    fs.mkdirSync(nodeProject, { recursive: true }); fs.writeFileSync(path.join(nodeProject, 'package.json'), '{}');
    fs.mkdirSync(rustProject, { recursive: true }); fs.writeFileSync(path.join(rustProject, 'Cargo.toml'), '[package]');
    fs.mkdirSync(ignored, { recursive: true }); fs.writeFileSync(path.join(ignored, 'package.json'), '{}');

    let grantWrites = 0;
    const d = makeProjectDiscovery({
      fsp, pathMod: path, roots: () => [shelf, shelf, path.join(root, 'missing')],
      isBlessed: p => path.resolve(p) === path.resolve(rustProject),
      bless: () => { grantWrites++; }
    });
    const r = await d.discover();
    A.eq(r.ok, true, 'bounded discovery completes');
    A.eq(r.roots.length, 1, 'duplicate and missing roots are removed');
    A.eq(r.candidates.length, 2, 'project markers are found across bounded depths');
    A.eq(r.candidates.some(x => x.root === nodeProject && x.kind === 'node' && x.blessed === false), true, 'ungranted Node project is a candidate only');
    A.eq(r.candidates.some(x => x.root === rustProject && x.kind === 'rust' && x.blessed === true), true, 'existing owner grant is joined as metadata');
    A.eq(r.candidates.some(x => /node_modules/.test(x.root)), false, 'dependency trees are never searched as projects');
    A.eq(r.grantsChanged, false, 'response explicitly reports that discovery granted nothing');
    A.eq(grantWrites, 0, 'discovery has no grant-writing seam');

    const capped = await d.discover({ maxDirs: 1, maxProjects: 1 });
    A.eq(capped.truncated, true, 'hard search ceilings report truncation honestly');
    A.ok(capped.dirsScanned <= 1, 'directory ceiling is enforced');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.report('project-discovery.test');
})().catch(e => { console.error(e); process.exit(1); });
