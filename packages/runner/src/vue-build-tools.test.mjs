import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VUE_FEATURED_CELLS } from './vue-artifact-assertions.mjs';
import {
  prepareVueFeaturedBuildTools,
  resolveVueFeaturedRspeedy,
} from './vue-build-tools.mjs';

function writeExecutable(file, source = '#!/usr/bin/env node\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

function installRspeedy(checkout, toolRoot, {
  version,
  binary = '#!/usr/bin/env node\n',
  files = {},
  dependencies = {},
} = {}) {
  const root = path.join(checkout, toolRoot);
  writeExecutable(path.join(root, 'node_modules/.bin/rspeedy'));
  writeExecutable(
    path.join(root, 'node_modules/@lynx-js/rspeedy/bin/rspeedy.js'),
    binary,
  );
  fs.writeFileSync(
    path.join(root, 'node_modules/@lynx-js/rspeedy/package.json'),
    JSON.stringify({
      name: '@lynx-js/rspeedy',
      version,
      bin: { rspeedy: './bin/rspeedy.js' },
      dependencies,
    }),
  );
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, 'node_modules/@lynx-js/rspeedy', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

function installPackage(checkout, toolRoot, name, {
  version,
  files = {},
} = {}) {
  const root = path.join(checkout, toolRoot, 'node_modules', ...name.split('/'));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name, version }),
  );
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
}

test('React tool selection fails closed without its app-local Rspeedy before build work', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-build-tools-react-'));
  const marker = path.join(checkout, 'build-started');
  try {
    fs.mkdirSync(path.join(checkout, 'packages/benchmark'), { recursive: true });
    installRspeedy(checkout, 'packages/benchmark', { version: '0.13.5' });
    writeExecutable(
      path.join(checkout, 'node_modules/.bin/tsc'),
      `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
`,
    );
    writeExecutable(path.join(checkout, 'node_modules/.bin/rslib'));

    const result = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts/build-vue-featured.mjs'),
      checkout,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /missing react Rspeedy install shim: packages\/benchmark\/apps\/ui-react\/node_modules\/\.bin\/rspeedy/,
    );
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(path.join(checkout, 'bench-out')), false);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('Vue cells resolve only the benchmark-level Rspeedy root', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-build-tools-vue-'));
  try {
    installRspeedy(checkout, 'packages/benchmark', {
      version: '0.13.5',
      binary: '#!/usr/bin/env node\n// benchmark Vue tool\n',
    });
    installRspeedy(checkout, 'packages/benchmark/apps/ui-vapor', {
      version: '9.9.9-wrong',
      binary: '#!/usr/bin/env node\n// must never be selected\n',
    });
    const vapor = VUE_FEATURED_CELLS.find(({ id }) => id === 'vue-vapor');
    const resolved = resolveVueFeaturedRspeedy(checkout, vapor);
    assert.equal(resolved.identity.toolRoot, 'packages/benchmark');
    assert.equal(resolved.identity.version, '0.13.5');
    assert.equal(
      resolved.identity.binaryPath,
      'packages/benchmark/node_modules/@lynx-js/rspeedy/bin/rspeedy.js',
    );
    assert.equal(
      resolved.identity.shimPath,
      'packages/benchmark/node_modules/.bin/rspeedy',
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('Rspeedy version or any published package bytes produce distinct stable identities', () => {
  const make = ({ version, binary, files }) => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-build-tools-split-'));
    installRspeedy(checkout, 'packages/benchmark', { version, binary, files });
    const vapor = VUE_FEATURED_CELLS.find(({ id }) => id === 'vue-vapor');
    const prepared = prepareVueFeaturedBuildTools(checkout, [{ ...vapor, rows: 0 }]);
    return { checkout, identity: prepared[0].tool.identity };
  };
  const first = make({
    version: '0.13.5',
    binary: '#!/usr/bin/env node\n// first\n',
    files: { 'dist/main.js': '// package tree first\n' },
  });
  const changedBytes = make({
    version: '0.13.5',
    binary: '#!/usr/bin/env node\n// first\n',
    files: { 'dist/main.js': '// package tree second\n' },
  });
  const changedVersion = make({
    version: '0.13.6',
    binary: '#!/usr/bin/env node\n// first\n',
    files: { 'dist/main.js': '// package tree first\n' },
  });
  try {
    assert.equal(first.identity.binarySha256, changedBytes.identity.binarySha256);
    assert.equal(first.identity.packageSha256, changedBytes.identity.packageSha256);
    assert.notEqual(
      first.identity.packageTreeSha256,
      changedBytes.identity.packageTreeSha256,
    );
    assert.notEqual(first.identity.fingerprint, changedBytes.identity.fingerprint);
    assert.notEqual(first.identity.packageSha256, changedVersion.identity.packageSha256);
    assert.notEqual(first.identity.fingerprint, changedVersion.identity.fingerprint);
    for (const identity of [
      first.identity,
      changedBytes.identity,
      changedVersion.identity,
    ]) {
      assert.match(identity.fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(path.isAbsolute(identity.binaryPath), false);
      assert.equal(path.isAbsolute(identity.packagePath), false);
    }
  } finally {
    for (const fixture of [first, changedBytes, changedVersion]) {
      fs.rmSync(fixture.checkout, { recursive: true, force: true });
    }
  }
});

test('transitive compiler dependency bytes split the complete graph fingerprint', () => {
  const make = (dependencyBytes) => {
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-build-tools-graph-'));
    installRspeedy(checkout, 'packages/benchmark', {
      version: '0.13.5',
      dependencies: { '@fixture/compiler-core': '1.0.0' },
    });
    installPackage(
      checkout,
      'packages/benchmark',
      '@fixture/compiler-core',
      {
        version: '1.0.0',
        files: { 'dist/index.js': dependencyBytes },
      },
    );
    const vapor = VUE_FEATURED_CELLS.find(({ id }) => id === 'vue-vapor');
    return {
      checkout,
      identity: resolveVueFeaturedRspeedy(checkout, vapor).identity,
    };
  };
  const first = make('// dependency first\n');
  const second = make('// dependency second\n');
  try {
    assert.equal(first.identity.packageTreeSha256, second.identity.packageTreeSha256);
    assert.notEqual(
      first.identity.compilerGraph.graphSha256,
      second.identity.compilerGraph.graphSha256,
    );
    assert.notEqual(first.identity.fingerprint, second.identity.fingerprint);
    assert.ok(first.identity.compilerGraph.packages.some(
      ({ name }) => name === '@fixture/compiler-core',
    ));
  } finally {
    fs.rmSync(first.checkout, { recursive: true, force: true });
    fs.rmSync(second.checkout, { recursive: true, force: true });
  }
});
