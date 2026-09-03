import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createVueArtifactAssertions,
  expectedVueArtifactBanner,
  expectedVueArtifactMarker,
  verifyVueArtifactAssertions,
} from './vue-artifact-assertions.mjs';

const expectation = { mode: 'vapor-ifr', rows: 1000, ifr: 1, et: 0 };

function bundleFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-artifact-marker-'));
  const marker = expectedVueArtifactMarker(expectation);
  const files = Object.fromEntries(['web', 'lynx'].map((flavor) => {
    const name = `main.${flavor}.bundle`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${flavor}:${expectedVueArtifactBanner(marker)}:end`);
    return [name, file];
  }));
  return { dir, files, marker };
}

test('artifact assertions record and revalidate both exact bundle markers', () => {
  const fixture = bundleFixture();
  try {
    const assertions = createVueArtifactAssertions(expectation, fixture.files);
    assert.equal(assertions.marker, fixture.marker);
    assert.deepEqual(assertions.assertions, expectation);
    for (const metadata of Object.values(assertions.bundles)) {
      assert.equal(metadata.prefixCount, 1);
      assert.equal(metadata.bannerCount, 1);
      assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
      assert.ok(metadata.size > fixture.marker.length);
    }
    assert.equal(
      verifyVueArtifactAssertions(assertions, expectation, fixture.files),
      assertions,
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('artifact assertions require exactly one complete static banner', () => {
  const cases = [
    ['missing', 'no artifact marker'],
    ['duplicate', null],
    ['wrong row', 'vue-lynx-bench-artifact-v1|mode=vapor-ifr|rows=0|ifr=1|et=0'],
    ['wrong cell', 'vue-lynx-bench-artifact-v1|mode=vapor|rows=1000|ifr=0|et=0'],
    ['wrong IFR', 'vue-lynx-bench-artifact-v1|mode=vapor-ifr|rows=1000|ifr=0|et=0'],
    ['wrong ET', 'vue-lynx-bench-artifact-v1|mode=vapor-ifr|rows=1000|ifr=1|et=1'],
    ['stale prefix', null],
    ['dot extension', null],
    ['colon extension', null],
  ];
  for (const [index, [label, replacement]] of cases.entries()) {
    const fixture = bundleFixture();
    try {
      const flavor = index % 2 === 0 ? 'main.web.bundle' : 'main.lynx.bundle';
      const banner = expectedVueArtifactBanner(fixture.marker);
      const invalid = label === 'duplicate'
        ? `${banner}:${banner}`
        : label === 'stale prefix'
        ? `${banner}:vue-lynx-bench-artifact-v1|mode=vapor|rows=0|ifr=0|et=0`
        : label === 'dot extension'
        ? `/*! ${fixture.marker}.extra */`
        : label === 'colon extension'
        ? `/*! ${fixture.marker}:extra */`
        : expectedVueArtifactBanner(replacement);
      fs.writeFileSync(fixture.files[flavor], invalid);
      assert.throws(
        () => createVueArtifactAssertions(expectation, fixture.files),
        /expected exactly one static banner/,
        label,
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});

test('artifact assertions accept the correct complete banner for the requested cell', () => {
  const fixture = bundleFixture();
  try {
    assert.doesNotThrow(() => createVueArtifactAssertions(expectation, fixture.files));
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('artifact assertion metadata tampering is rejected', () => {
  for (const key of ['prefixCount', 'bannerCount', 'sha256', 'size']) {
    const fixture = bundleFixture();
    try {
      const assertions = createVueArtifactAssertions(expectation, fixture.files);
      if (key === 'sha256') {
        assertions.bundles['main.web.bundle'][key] = '0'.repeat(64);
      } else {
        assertions.bundles['main.web.bundle'][key]++;
      }
      assert.throws(
        () => verifyVueArtifactAssertions(assertions, expectation, fixture.files),
        new RegExp(`main\\.web\\.bundle artifact ${key}`),
        key,
      );
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  }
});
