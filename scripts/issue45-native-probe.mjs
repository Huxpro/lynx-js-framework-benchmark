#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const ISSUE45_N0_PROTOCOL = 'lynx-bench-pipeline-native-n0-v1';
export const ISSUE45_N0_MARKER = '__ISSUE45_N0_RESULT__';
export const ISSUE45_N1_PROTOCOL = 'lynx-bench-pipeline-native-counts-v1';
export const ISSUE45_N1_MARKER = '__ISSUE45_N1_RESULT__';

// This list is the public Element PAPI surface consumed by Octane's native
// renderer. It stays method-granular in evidence; segment grouping is applied
// later with packages/shared/src/pipeline.mjs, never reimplemented here.
export const ISSUE45_PAPI_METHODS = Object.freeze([
  '__CreatePage',
  '__CreateElement',
  '__CreateView',
  '__CreateScrollView',
  '__CreateText',
  '__CreateRawText',
  '__CreateImage',
  '__CreateList',
  '__UpdateListCallbacks',
  '__GetElementUniqueID',
  '__GetParent',
  '__ElementIsEqual',
  '__AppendElement',
  '__InsertElementBefore',
  '__RemoveElement',
  '__ReplaceElement',
  '__SetClasses',
  '__SetInlineStyles',
  '__SetCSSId',
  '__SetAttribute',
  '__SetDataset',
  '__AddEvent',
  '__SetID',
  '__FlushElementTree',
]);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function methodProbeSource(name) {
  const original = `__issue45_original_${name.slice(2)}`;
  const wrapper = `__issue45_wrapper_${name.slice(2)}`;
  return `
  (function () {
    var binding = { present: typeof ${name} === 'function', rebound: false, assignmentError: null };
    probe.bindings[${JSON.stringify(name)}] = binding;
    if (!binding.present) return;
    var ${original} = ${name};
    var ${wrapper} = function () {
      probe.counts[${JSON.stringify(name)}] = (probe.counts[${JSON.stringify(name)}] || 0) + 1;
      return ${original}.apply(this, arguments);
    };
    try {
      ${name} = ${wrapper};
      binding.rebound = ${name} === ${wrapper};
    } catch (error) {
      binding.assignmentError = String(error);
    }
  })();`;
}

/** Exact source prepended to the compiled MTS asset before TASM encoding. */
export function makeIssue45N0MtsPrefix({ rows = 100 } = {}) {
  if (!Number.isSafeInteger(rows) || rows < 1) throw new TypeError('N0 rows must be positive.');
  const methods = ISSUE45_PAPI_METHODS.map(methodProbeSource).join('\n');
  return `;/* issue #45 N0: exact MTS prefix; generated, do not minify separately */
(function () {
  var probe = globalThis.__ISSUE45_N0__ = {
    protocol: ${JSON.stringify(ISSUE45_N0_PROTOCOL)},
    rows: ${rows},
    bindings: {},
    counts: {},
    clocks: {},
    clockSurface: {},
    reportError: null
  };

  function clock(name, read) {
    var first;
    try {
      first = read();
    } catch (error) {
      probe.clocks[name] = { available: false, error: String(error) };
      return;
    }
    var previous = first;
    var minimumPositiveMs = Infinity;
    var positiveDeltas = 0;
    var equalReads = 0;
    var backwardReads = 0;
    var reads = 0;
    var wallDeadline = Date.now() + 40;
    while (reads < 200000 && (positiveDeltas < 32 || Date.now() < wallDeadline)) {
      var current = read();
      var delta = current - previous;
      if (delta > 0) {
        positiveDeltas++;
        if (delta < minimumPositiveMs) minimumPositiveMs = delta;
      } else if (delta === 0) equalReads++;
      else backwardReads++;
      previous = current;
      reads++;
    }
    probe.clocks[name] = {
      available: true,
      first: first,
      last: previous,
      reads: reads,
      positiveDeltas: positiveDeltas,
      equalReads: equalReads,
      backwardReads: backwardReads,
      resolutionMs: minimumPositiveMs === Infinity ? null : minimumPositiveMs,
      monotonicObserved: backwardReads === 0
    };
  }

  clock('Date.now', function () { return Date.now(); });
  if (typeof performance === 'object' && performance && typeof performance.now === 'function') {
    clock('performance.now', function () { return performance.now(); });
  } else {
    probe.clocks['performance.now'] = { available: false, error: 'not a function' };
  }
  if (typeof lynx === 'object' && lynx && lynx.performance && typeof lynx.performance.now === 'function') {
    clock('lynx.performance.now', function () { return lynx.performance.now(); });
  } else {
    probe.clocks['lynx.performance.now'] = { available: false, error: 'not a function' };
  }

  try {
    var surfaces = [
      ['globalThis', globalThis],
      ['performance', typeof performance === 'object' ? performance : null],
      ['lynx.performance', typeof lynx === 'object' && lynx ? lynx.performance : null]
    ];
    for (var surfaceIndex = 0; surfaceIndex < surfaces.length; surfaceIndex++) {
      var label = surfaces[surfaceIndex][0];
      var value = surfaces[surfaceIndex][1];
      if (!value) continue;
      var names = Object.getOwnPropertyNames(value);
      var matches = {};
      for (var nameIndex = 0; nameIndex < names.length; nameIndex++) {
        var property = names[nameIndex];
        if (/now|time|clock|perf/i.test(property)) matches[property] = typeof value[property];
      }
      probe.clockSurface[label] = matches;
    }
  } catch (error) {
    probe.clockSurface.error = String(error);
  }
${methods}

  function report() {
    try {
      console.log(${JSON.stringify(ISSUE45_N0_MARKER)} + JSON.stringify(probe));
    } catch (error) {
      probe.reportError = String(error);
      console.log(${JSON.stringify(ISSUE45_N0_MARKER)} + '{"protocol":${ISSUE45_N0_PROTOCOL},"reportError":"' + String(error) + '"}');
    }
  }
  try {
    lynx.requestAnimationFrame(function () {
      lynx.requestAnimationFrame(report);
    });
  } catch (error) {
    probe.reportError = String(error);
    if (typeof setTimeout === 'function') setTimeout(report, 50);
    else report();
  }
})();`;
}

/** Count-only N1 source. Deliberately contains no clock read in a PAPI wrapper. */
export function makeIssue45N1MtsPrefix({ entry, rows = 1000 } = {}) {
  if (typeof entry !== 'string' || entry.length === 0) throw new TypeError('N1 entry is required.');
  if (!Number.isSafeInteger(rows) || rows < 1) throw new TypeError('N1 rows must be positive.');
  const methods = ISSUE45_PAPI_METHODS.map(methodProbeSource).join('\n');
  return `;/* issue #45 N1: exact count-only MTS prefix; generated, do not minify separately */
(function () {
  var probe = globalThis.__ISSUE45_N1__ = {
    protocol: ${JSON.stringify(ISSUE45_N1_PROTOCOL)},
    entry: ${JSON.stringify(entry)},
    rows: ${rows},
    bindings: {},
    counts: {},
    reportError: null
  };
${methods}

  function report() {
    try {
      console.log(${JSON.stringify(ISSUE45_N1_MARKER)} + JSON.stringify(probe));
    } catch (error) {
      probe.reportError = String(error);
    }
  }
  try {
    lynx.requestAnimationFrame(function () {
      lynx.requestAnimationFrame(report);
    });
  } catch (error) {
    probe.reportError = String(error);
    if (typeof setTimeout === 'function') setTimeout(report, 50);
    else report();
  }
})();`;
}

const CONFIG_IMPORT_ANCHOR = "import { defineConfig } from '@lynx-js/rspeedy';\n";
const CONFIG_TOOLS_ANCHOR = '\t\tsource: {\n';

const CONFIG_PLUGIN_SOURCE = `import { LynxTemplatePlugin } from '@lynx-js/template-webpack-plugin';

class Issue45MtsPrefixPlugin {
\tapply(compiler) {
\t\tcompiler.hooks.thisCompilation.tap(this.constructor.name, (compilation) => {
\t\t\tconst hooks = LynxTemplatePlugin.getLynxTemplatePluginHooks(compilation);
\t\t\thooks.beforeEncode.tapPromise(this.constructor.name, async (args) => {
\t\t\t\tconst encoded = process.env.BENCH_ISSUE45_MTS_PREFIX_BASE64;
\t\t\t\tif (encoded) {
\t\t\t\t\tconst root = args.encodeData.lepusCode?.root;
\t\t\t\t\tif (!root) throw new Error('issue #45 could not find the MTS root asset.');
\t\t\t\t\tconst prefix = Buffer.from(encoded, 'base64').toString('utf8');
\t\t\t\t\targs.encodeData.lepusCode.root = {
\t\t\t\t\t\t...root,
\t\t\t\t\t\tsource: new compiler.webpack.sources.RawSource(
\t\t\t\t\t\t\tprefix + '\\n' + root.source.source().toString(),
\t\t\t\t\t\t),
\t\t\t\t\t};
\t\t\t\t}
\t\t\t\tconst btsEncoded = process.env.BENCH_ISSUE45_BTS_PREFIX_BASE64;
\t\t\t\tif (btsEncoded) {
\t\t\t\t\tconst manifest = args.encodeData.manifest;
\t\t\t\t\tconst btsNames = Object.keys(manifest).filter((name) => /background\\.js$/.test(name));
\t\t\t\t\tif (btsNames.length > 1) throw new Error('issue #45 found ambiguous background JS assets.');
\t\t\t\t\tif (btsNames.length === 1) {
\t\t\t\t\t\tconst btsSource = manifest[btsNames[0]];
\t\t\t\t\t\tconst promiseAliases = [...btsSource.matchAll(/var ([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\.Promise;/g)];
\t\t\t\t\t\tif (promiseAliases.length > 1) throw new Error('issue #45 Promise alias is ambiguous.');
\t\t\t\t\t\tif (promiseAliases.length === 1) {
\t\t\t\t\t\t\tconst promiseAlias = promiseAliases[0][1];
\t\t\t\t\t\t\tconst btsTemplate = Buffer.from(btsEncoded, 'base64').toString('utf8');
\t\t\t\t\t\t\tconst btsShim = btsTemplate.replaceAll('__ISSUE45_PROMISE__', promiseAlias);
\t\t\t\t\t\t\tconst promiseAnchor = promiseAliases[0][0];
\t\t\t\t\t\t\tmanifest[btsNames[0]] = btsSource.replace(promiseAnchor, promiseAnchor + btsShim);
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\treturn args;
\t\t\t});
\t\t});
\t}
}
`;

export function makeIssue45BtsCompatPrefix() {
  return `;/* issue #45 N1: SDK 4.0 BTS compatibility; exact evidence template */
  if (typeof __ISSUE45_PROMISE__.allSettled !== 'function') {
    __ISSUE45_PROMISE__.allSettled = function (values) {
      return __ISSUE45_PROMISE__.all(Array.from(values, function (value) {
        return __ISSUE45_PROMISE__.resolve(value).then(function (result) {
          return { status: 'fulfilled', value: result };
        }, function (reason) {
          return { status: 'rejected', reason: reason };
        });
      }));
    };
  }`;
}

const REACT_CONFIG_PLUGIN_SOURCE = CONFIG_PLUGIN_SOURCE.replace(
  "import { LynxTemplatePlugin } from '@lynx-js/template-webpack-plugin';",
  `import { createRequire } from 'node:module';

const issue45ReactPluginRequire = createRequire(
  import.meta.resolve('@lynx-js/react-rsbuild-plugin'),
);
const issue45TemplatePackage = issue45ReactPluginRequire.resolve(
  '@lynx-js/template-webpack-plugin/package.json',
);
const { LynxTemplatePlugin } = await import(
  issue45TemplatePackage.replace(/package\\.json$/, 'lib/index.js'),
);`,
);

const REACT_CONFIG_IMPORT_ANCHOR = "import { defineConfig } from '@lynx-js/rspeedy';\n";
const REACT_CONFIG_PLUGIN_ANCHOR = '  plugins: [pluginReactLynx()],\n';

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first === -1) throw new Error(`issue #45 anchor missing in ${label}.`);
  if (source.indexOf(search, first + search.length) !== -1) {
    throw new Error(`issue #45 anchor is ambiguous in ${label}.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

export function patchOctaneConfigForIssue45(source) {
  let next = replaceOnce(
    source,
    CONFIG_IMPORT_ANCHOR,
    CONFIG_IMPORT_ANCHOR + CONFIG_PLUGIN_SOURCE,
    'Octane lynx.config.mjs import',
  );
  next = replaceOnce(
    next,
    CONFIG_TOOLS_ANCHOR,
    '\t\ttools: { rspack: { plugins: [new Issue45MtsPrefixPlugin()] } },\n' + CONFIG_TOOLS_ANCHOR,
    'Octane lynx.config.mjs config',
  );
  return next;
}

export function patchReactConfigForIssue45(source) {
  let next = replaceOnce(
    source,
    REACT_CONFIG_IMPORT_ANCHOR,
    REACT_CONFIG_IMPORT_ANCHOR + REACT_CONFIG_PLUGIN_SOURCE,
    'ReactLynx lynx.config.ts import',
  );
  next = replaceOnce(
    next,
    REACT_CONFIG_PLUGIN_ANCHOR,
    '  tools: { rspack: { plugins: [new Issue45MtsPrefixPlugin()] } },\n'
      + REACT_CONFIG_PLUGIN_ANCHOR,
    'ReactLynx lynx.config.ts config',
  );
  return next;
}

function decodeTasmBundle(bundlePath, scratchDirectory, label) {
  const output = path.join(scratchDirectory, `${label}.json`);
  execFileSync(
    'npx',
    ['--yes', '@lynx-js/tasm@0.0.39', 'decode', '-i', bundlePath, '-o', output],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

function decodedMtsBytes(decoded, label) {
  const values = decoded?.['main-thread-script']?.lepus_code;
  if (!Array.isArray(values) || values.some((value) => !Number.isInteger(value))) {
    throw new Error(`${label} has no decoded LepusNG MTS bytecode.`);
  }
  return Buffer.from(values);
}

function uniqueBufferOffset(haystack, needle, label) {
  const offset = haystack.indexOf(needle);
  if (offset === -1) throw new Error(`${label} bytecode was not found in its bundle.`);
  if (haystack.indexOf(needle, offset + 1) !== -1) {
    throw new Error(`${label} bytecode occurs more than once in its bundle.`);
  }
  return offset;
}

function withoutMtsAndSize(decoded) {
  const { ['main-thread-script']: _mts, ['total-size']: _size, ...rest } = decoded;
  return rest;
}

function withoutGeneratedScriptsAndSize(decoded) {
  const {
    ['main-thread-script']: _mts,
    ['background-thread-script']: _bts,
    ['total-size']: _size,
    ...rest
  } = decoded;
  return rest;
}

function zeroUniqueMetadataHash(buffer, prefix, label) {
  const marker = Buffer.from(prefix);
  const offset = buffer.indexOf(marker);
  if (offset === -1 || buffer.indexOf(marker, offset + marker.length) !== -1) {
    throw new Error(`${label} metadata marker is missing or ambiguous.`);
  }
  const start = offset + marker.length;
  const hash = buffer.subarray(start, start + 40).toString('ascii');
  if (!/^[0-9a-f]{40}$/.test(hash)) throw new Error(`${label} metadata hash is malformed.`);
  buffer.fill(48, start, start + 40);
  return hash;
}

function proveAlphaRenameEquivalent(actualValue, expectedValue, {
  label,
  metadataPrefix,
  symbolA,
  symbolB,
}) {
  const actual = Buffer.from(actualValue);
  const expected = Buffer.from(expectedValue);
  assert.equal(actual.length, expected.length, `${label} byte length drifted`);
  const actualMetadataHash = zeroUniqueMetadataHash(actual, metadataPrefix, `${label} actual`);
  const expectedMetadataHash = zeroUniqueMetadataHash(expected, metadataPrefix, `${label} expected`);
  const a = symbolA.charCodeAt(0);
  const b = symbolB.charCodeAt(0);
  let alphaRenameByteCount = 0;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] === expected[index]) continue;
    const allowed = (actual[index] === a && expected[index] === b)
      || (actual[index] === b && expected[index] === a);
    if (!allowed) throw new Error(`${label} differs beyond metadata and ${symbolA}/${symbolB} alpha-renaming at byte ${index}.`);
    alphaRenameByteCount += 1;
  }
  return {
    metadataPrefix,
    actualMetadataHash,
    expectedMetadataHash,
    alphaRename: `${symbolA}<->${symbolB}`,
    alphaRenameByteCount,
  };
}

function replaceUniqueBefore(buffer, from, to, limit, label) {
  if (from.length !== to.length) throw new Error(`${label} changed byte length.`);
  const prefix = buffer.subarray(0, limit);
  const first = prefix.indexOf(from);
  if (first === -1) throw new Error(`${label} was not found before ROOT_LEPUS.`);
  if (prefix.indexOf(from, first + 1) !== -1) throw new Error(`${label} is ambiguous before ROOT_LEPUS.`);
  to.copy(buffer, first);
  return from.length;
}

function replaceAllBefore(buffer, from, to, limit, label) {
  if (from.length !== to.length) throw new Error(`${label} changed byte length.`);
  let count = 0;
  let offset = 0;
  while (offset < limit) {
    const found = buffer.subarray(0, limit).indexOf(from, offset);
    if (found === -1) break;
    to.copy(buffer, found);
    count += 1;
    offset = found + to.length;
  }
  if (count === 0) throw new Error(`${label} was not found before ROOT_LEPUS.`);
  return count * from.length;
}

const UPSTREAM_MESSAGECHANNEL_ANCHOR = 'const _stormChannel = new MessageChannel();';
const UPSTREAM_MESSAGECHANNEL_FALLBACK = `const _stormChannel: {
\tport1: { onmessage: (() => void) | null };
\tport2: { postMessage(value: number): void };
} = {
\tport1: { onmessage: null },
\tport2: {
\t\tpostMessage() {
\t\t\tsetTimeout(() => _stormChannel.port1.onmessage?.(), 0);
\t\t},
\t},
};`;

export function patchUpstreamMessageChannelForIssue45(source) {
  return replaceOnce(
    source,
    UPSTREAM_MESSAGECHANNEL_ANCHOR,
    UPSTREAM_MESSAGECHANNEL_FALLBACK,
    'Octane upstream MessageChannel fallback',
  );
}

/**
 * Preserve a checked-in ReactLynx bundle section-for-section while replacing
 * only its MTS with a source-prefixed build. The clean baseline build must
 * decode to the vendored MTS byte-for-byte. Any baseline/vendored binary
 * differences must occur before ROOT_LEPUS, where equal-length BTS chunk names
 * and sources live; those bytes are copied onto the prefixed build.
 */
export function deriveVendoredReactN1Bundle({
  sourceRoot,
  vendoredBundle,
  output,
  rows = 1000,
  quiet = false,
}) {
  const root = path.resolve(sourceRoot);
  const app = path.join(root, 'packages/benchmark/apps/ui-react');
  const config = path.join(app, 'lynx.config.ts');
  const dist = path.join(app, 'dist');
  const built = path.join(dist, 'main.lynx.bundle');
  const rspeedy = path.join(app, 'node_modules/.bin/rspeedy');
  const originalConfig = fs.readFileSync(config, 'utf8');
  const prefix = makeIssue45N1MtsPrefix({ entry: 'react', rows });
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const runBuild = (instrumented) => {
    fs.rmSync(dist, { recursive: true, force: true });
    fs.writeFileSync(config, instrumented ? patchReactConfigForIssue45(originalConfig) : originalConfig);
    execFileSync(rspeedy, ['build'], {
      cwd: app,
      stdio: quiet ? 'pipe' : 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        BENCH_AUTOROWS: String(rows),
        ...(instrumented
          ? { BENCH_ISSUE45_MTS_PREFIX_BASE64: Buffer.from(prefix).toString('base64') }
          : {}),
      },
    });
    return fs.readFileSync(built);
  };

  let baselineBytes;
  let instrumentedBytes;
  try {
    baselineBytes = runBuild(false);
    instrumentedBytes = runBuild(true);
  } finally {
    fs.writeFileSync(config, originalConfig);
  }

  const vendoredPath = path.resolve(vendoredBundle);
  const vendoredBytes = fs.readFileSync(vendoredPath);
  const scratch = fs.mkdtempSync(path.join(path.dirname(outputPath), '.issue45-decode-'));
  try {
    // The second build overwrote `built`; decode the saved buffers through
    // explicit scratch files so each proof names the bytes it actually checks.
    const baselinePath = path.join(scratch, 'baseline.lynx.bundle');
    const instrumentedPath = path.join(scratch, 'instrumented.lynx.bundle');
    fs.writeFileSync(baselinePath, baselineBytes);
    fs.writeFileSync(instrumentedPath, instrumentedBytes);
    const actualBaselineDecoded = decodeTasmBundle(baselinePath, scratch, 'baseline');
    const vendoredDecoded = decodeTasmBundle(vendoredPath, scratch, 'vendored');
    const instrumentedDecoded = decodeTasmBundle(instrumentedPath, scratch, 'instrumented');

    const baselineMts = decodedMtsBytes(actualBaselineDecoded, 'baseline ReactLynx');
    const vendoredMts = decodedMtsBytes(vendoredDecoded, 'vendored ReactLynx');
    const instrumentedMts = decodedMtsBytes(instrumentedDecoded, 'instrumented ReactLynx');
    assert.deepEqual(baselineMts, vendoredMts, 'ReactLynx baseline MTS must equal vendored MTS');
    if (!instrumentedMts.includes(Buffer.from(ISSUE45_N1_MARKER))) {
      throw new Error('instrumented ReactLynx MTS does not contain the N1 marker.');
    }
    assert.equal(baselineBytes.length, vendoredBytes.length, 'ReactLynx baseline size drifted');
    const baselineMtsOffset = uniqueBufferOffset(baselineBytes, baselineMts, 'baseline ReactLynx MTS');
    const vendoredMtsOffset = uniqueBufferOffset(vendoredBytes, vendoredMts, 'vendored ReactLynx MTS');
    const instrumentedMtsOffset = uniqueBufferOffset(
      instrumentedBytes,
      instrumentedMts,
      'instrumented ReactLynx MTS',
    );
    assert.equal(vendoredMtsOffset, baselineMtsOffset, 'vendored MTS offset drifted');
    assert.equal(instrumentedMtsOffset, baselineMtsOffset, 'MTS prefix moved the ROOT_LEPUS payload');

    const differingOffsets = [];
    for (let index = 0; index < baselineBytes.length; index += 1) {
      if (baselineBytes[index] !== vendoredBytes[index]) differingOffsets.push(index);
    }
    if (differingOffsets.length === 0) throw new Error('ReactLynx baseline unexpectedly equals vendored bundle.');
    if (differingOffsets.some((offset) => offset >= baselineMtsOffset)) {
      throw new Error('ReactLynx baseline/vendored differences cross into ROOT_LEPUS.');
    }

    const merged = Buffer.from(instrumentedBytes);
    const instrumentedScripts = instrumentedDecoded['background-thread-script'];
    const vendoredScripts = vendoredDecoded['background-thread-script'];
    assert.equal(instrumentedScripts.length, vendoredScripts.length, 'ReactLynx BTS file count drifted');
    let restoredVendoredScriptBytes = 0;
    for (let index = 0; index < vendoredScripts.length; index += 1) {
      const instrumentedScript = instrumentedScripts[index];
      const vendoredScript = vendoredScripts[index];
      assert.equal(instrumentedScript.type, vendoredScript.type, `ReactLynx BTS type ${index} drifted`);
      if (instrumentedScript.content !== vendoredScript.content) {
        restoredVendoredScriptBytes += replaceUniqueBefore(
          merged,
          Buffer.from(instrumentedScript.content),
          Buffer.from(vendoredScript.content),
          instrumentedMtsOffset,
          `ReactLynx BTS content ${index}`,
        );
      }
      if (instrumentedScript.path !== vendoredScript.path) {
        restoredVendoredScriptBytes += replaceAllBefore(
          merged,
          Buffer.from(instrumentedScript.path),
          Buffer.from(vendoredScript.path),
          instrumentedMtsOffset,
          `ReactLynx BTS path ${index}`,
        );
      }
    }
    fs.writeFileSync(outputPath, merged);
    const mergedDecoded = decodeTasmBundle(outputPath, scratch, 'merged');
    assert.deepEqual(
      withoutMtsAndSize(mergedDecoded),
      withoutMtsAndSize(vendoredDecoded),
      'derived ReactLynx bundle changed a non-MTS decoded section',
    );
    if (!decodedMtsBytes(mergedDecoded, 'derived ReactLynx').includes(Buffer.from(ISSUE45_N1_MARKER))) {
      throw new Error('derived ReactLynx MTS lost the N1 marker.');
    }

    const receipt = {
      protocol: ISSUE45_N1_PROTOCOL,
      kind: 'vendored-react-mts-prefix-receipt',
      createdAt: new Date().toISOString(),
      source: {
        repository: 'Huxpro/vue-lynx',
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim() !== '',
      },
      rows,
      injection: {
        placement: 'MTS asset prefix before TASM encoding; ROOT_LEPUS transplanted onto vendored sections',
        sha256: sha256(prefix),
        source: prefix,
      },
      vendored: {
        path: vendoredPath,
        bytes: vendoredBytes.length,
        sha256: sha256(vendoredBytes),
        mtsSha256: sha256(vendoredMts),
      },
      cleanBuild: {
        bytes: baselineBytes.length,
        sha256: sha256(baselineBytes),
        mtsSha256: sha256(baselineMts),
        mtsByteExactWithVendored: true,
      },
      transplant: {
        mtsPayloadOffset: baselineMtsOffset,
        baselineVendorDifferingByteCount: differingOffsets.length,
        firstBaselineVendorDifference: differingOffsets[0],
        lastBaselineVendorDifference: differingOffsets.at(-1),
        allBaselineVendorDifferencesBeforeMts: true,
        restoredVendoredScriptBytes,
        decodedNonMtsSectionsEqualVendored: true,
      },
      bundle: {
        path: outputPath,
        bytes: merged.length,
        sha256: sha256(merged),
        markerPresent: merged.includes(Buffer.from(ISSUE45_N1_MARKER)),
      },
    };
    fs.writeFileSync(`${outputPath}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'octane-root': { type: 'string' },
      'react-root': { type: 'string' },
      entry: { type: 'string' },
      core: { type: 'string' },
      vendored: { type: 'string' },
      rows: { type: 'string', default: '100' },
      out: { type: 'string' },
      quiet: { type: 'boolean', default: false },
    },
  });
  return { command: positionals[0] ?? null, values };
}

export function buildIssue45N0Bundle({ octaneRoot, rows = 100, output, quiet = false }) {
  const root = path.resolve(octaneRoot);
  const config = path.join(root, 'benchmarks/lynx-table/app/lynx.config.mjs');
  const buildScript = path.join(root, 'benchmarks/lynx-table/scripts/build-app.mjs');
  const original = fs.readFileSync(config, 'utf8');
  const prefix = makeIssue45N0MtsPrefix({ rows });
  const tag = 'issue45-n0';
  try {
    fs.writeFileSync(config, patchOctaneConfigForIssue45(original));
    execFileSync(process.execPath, [buildScript], {
      cwd: root,
      stdio: quiet ? 'pipe' : 'inherit',
      env: {
        ...process.env,
        BENCH_AUTOROWS: String(rows),
        BENCH_CORE: 'block',
        BENCH_BLOCK_MODE: 'scoped',
        BENCH_DIST_TAG: tag,
        BENCH_DEVICE_MESSAGECHANNEL_FALLBACK: '1',
        BENCH_ISSUE45_MTS_PREFIX_BASE64: Buffer.from(prefix).toString('base64'),
      },
    });
  } finally {
    fs.writeFileSync(config, original);
  }
  const built = path.join(
    root,
    `benchmarks/lynx-table/app/dist-block-${tag}-rows${rows}/main.lynx.bundle`,
  );
  const bytes = fs.readFileSync(built);
  if (!bytes.includes(Buffer.from(ISSUE45_N0_MARKER))) {
    throw new Error('built N0 bundle does not contain the checked-in result marker.');
  }
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(built, outputPath);
  const receipt = {
    protocol: ISSUE45_N0_PROTOCOL,
    kind: 'build-receipt',
    createdAt: new Date().toISOString(),
    source: {
      repository: 'Huxpro/octane',
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim() !== '',
    },
    rows,
    build: {
      core: 'block',
      blockMode: 'scoped',
      distTag: tag,
      deviceMessageChannelFallback: true,
      command: `BENCH_AUTOROWS=${rows} BENCH_CORE=block BENCH_BLOCK_MODE=scoped BENCH_DIST_TAG=${tag} BENCH_DEVICE_MESSAGECHANNEL_FALLBACK=1 node benchmarks/lynx-table/scripts/build-app.mjs`,
    },
    injection: {
      placement: 'MTS asset prefix before TASM encoding',
      sha256: sha256(prefix),
      source: prefix,
    },
    bundle: {
      path: outputPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      markerPresent: true,
    },
  };
  fs.writeFileSync(`${outputPath}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/** Build an Octane N1 arm and prove that its unprefixed MTS matches the vendored entry. */
export function buildIssue45N1OctaneBundle({
  octaneRoot,
  entry,
  vendoredBundle,
  rows = 1000,
  output,
  core = 'universal',
  quiet = false,
}) {
  if (entry !== 'octane' && entry !== 'octane-hux') {
    throw new TypeError('Octane N1 entry must be octane or octane-hux.');
  }
  if (core !== 'universal' && core !== 'block') {
    throw new TypeError('Octane N1 core must be universal or block.');
  }
  const root = path.resolve(octaneRoot);
  const config = path.join(root, 'benchmarks/lynx-table/app/lynx.config.mjs');
  const appSource = path.join(root, 'benchmarks/lynx-table/app/src/App.lynx.tsrx');
  const buildScript = path.join(root, 'benchmarks/lynx-table/scripts/build-app.mjs');
  const originalConfig = fs.readFileSync(config, 'utf8');
  const originalAppSource = fs.readFileSync(appSource, 'utf8');
  const buildScriptSource = fs.readFileSync(buildScript, 'utf8');
  const nativeFallbackViaBuild = buildScriptSource.includes('BENCH_DEVICE_MESSAGECHANNEL_FALLBACK');
  const directFallback = !nativeFallbackViaBuild;
  const supportsDistTag = originalConfig.includes('BENCH_DIST_TAG');
  const tag = supportsDistTag ? `issue45-n1-${entry}` : '';
  const corePrefix = core === 'block' ? '-block' : '';
  const tagSuffix = tag ? `-${tag}` : '';
  const built = path.join(
    root,
    `benchmarks/lynx-table/app/dist${corePrefix}${tagSuffix}-rows${rows}/main.lynx.bundle`,
  );
  const prefix = makeIssue45N1MtsPrefix({ entry, rows });
  const btsCompatPrefix = makeIssue45BtsCompatPrefix();
  const outputPath = path.resolve(output);
  const vendoredPath = path.resolve(vendoredBundle);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const runBuild = (instrumented) => {
    fs.writeFileSync(config, instrumented ? patchOctaneConfigForIssue45(originalConfig) : originalConfig);
    if (instrumented && directFallback) {
      fs.writeFileSync(appSource, patchUpstreamMessageChannelForIssue45(originalAppSource));
    } else {
      fs.writeFileSync(appSource, originalAppSource);
    }
    execFileSync(process.execPath, [buildScript], {
      cwd: root,
      stdio: quiet ? 'pipe' : 'inherit',
      env: {
        ...process.env,
        BENCH_AUTOROWS: String(rows),
        BENCH_CORE: core,
        BENCH_BLOCK_MODE: 'scoped',
        ...(tag ? { BENCH_DIST_TAG: tag } : {}),
        ...(instrumented && nativeFallbackViaBuild
          ? { BENCH_DEVICE_MESSAGECHANNEL_FALLBACK: '1' }
          : {}),
        ...(instrumented
          ? {
              BENCH_ISSUE45_MTS_PREFIX_BASE64: Buffer.from(prefix).toString('base64'),
              BENCH_ISSUE45_BTS_PREFIX_BASE64: Buffer.from(btsCompatPrefix).toString('base64'),
            }
          : {}),
      },
    });
    return fs.readFileSync(built);
  };

  let baselineBytes;
  let instrumentedBytes;
  try {
    baselineBytes = runBuild(false);
    instrumentedBytes = runBuild(true);
  } finally {
    fs.writeFileSync(config, originalConfig);
    fs.writeFileSync(appSource, originalAppSource);
  }

  const vendoredBytes = fs.readFileSync(vendoredPath);
  const scratch = fs.mkdtempSync(path.join(path.dirname(outputPath), '.issue45-decode-'));
  try {
    const baselinePath = path.join(scratch, 'baseline.lynx.bundle');
    const instrumentedPath = path.join(scratch, 'instrumented.lynx.bundle');
    fs.writeFileSync(baselinePath, baselineBytes);
    fs.writeFileSync(instrumentedPath, instrumentedBytes);
    const baselineDecoded = decodeTasmBundle(baselinePath, scratch, 'baseline');
    const vendoredDecoded = decodeTasmBundle(vendoredPath, scratch, 'vendored');
    const instrumentedDecoded = decodeTasmBundle(instrumentedPath, scratch, 'instrumented');
    const baselineMts = decodedMtsBytes(baselineDecoded, `${entry} baseline`);
    const vendoredMts = decodedMtsBytes(vendoredDecoded, `${entry} vendored`);
    const instrumentedMts = decodedMtsBytes(instrumentedDecoded, `${entry} instrumented`);
    const compatMarker = 'issue #45 N1: SDK 4.0 BTS compatibility';
    const compatScripts = instrumentedDecoded['background-thread-script']
      .filter((script) => script.content.includes(compatMarker));
    assert.equal(compatScripts.length, 1, `${entry} final bundle must contain one BTS compatibility shim`);
    assert.match(compatScripts[0].content, /\.allSettled\s*=\s*function\s*\(/);
    const mtsByteExactWithVendored = baselineMts.equals(vendoredMts);
    let compilerEquivalence = null;
    if (mtsByteExactWithVendored) {
      assert.deepEqual(
        withoutGeneratedScriptsAndSize(baselineDecoded),
        withoutGeneratedScriptsAndSize(vendoredDecoded),
        `${entry} baseline static sections must equal vendored sections`,
      );
    } else {
      if (entry !== 'octane') throw new Error(`${entry} baseline MTS drifted from vendored MTS.`);
      assert.deepEqual(
        withoutGeneratedScriptsAndSize(baselineDecoded),
        withoutGeneratedScriptsAndSize(vendoredDecoded),
        'octane baseline static sections must equal vendored sections',
      );
      const mts = proveAlphaRenameEquivalent(baselineMts, vendoredMts, {
        label: 'octane baseline MTS',
        metadataPrefix: 'nldebugmetadata:',
        symbolA: '3',
        symbolB: '8',
      });
      const baselineScripts = baselineDecoded['background-thread-script'];
      const vendoredScripts = vendoredDecoded['background-thread-script'];
      assert.equal(baselineScripts.length, vendoredScripts.length, 'octane baseline BTS file count drifted');
      const bts = [];
      for (let index = 0; index < baselineScripts.length; index += 1) {
        const actualScript = baselineScripts[index];
        const expectedScript = vendoredScripts[index];
        assert.equal(actualScript.path, expectedScript.path, `octane baseline BTS path ${index} drifted`);
        assert.equal(actualScript.type, expectedScript.type, `octane baseline BTS type ${index} drifted`);
        if (actualScript.content === expectedScript.content) {
          bts.push({ path: actualScript.path, byteExact: true });
        } else {
          bts.push({
            path: actualScript.path,
            byteExact: false,
            ...proveAlphaRenameEquivalent(actualScript.content, expectedScript.content, {
              label: `octane baseline BTS ${actualScript.path}`,
              metadataPrefix: 'debugmetadata:',
              symbolA: '3',
              symbolB: '6',
            }),
          });
        }
      }
      compilerEquivalence = {
        kind: 'generated-debug-metadata-and-alpha-rename-only',
        staticDecodedSectionsEqualVendored: true,
        mts,
        bts,
      };
    }
    if (!instrumentedMts.includes(Buffer.from(ISSUE45_N1_MARKER))) {
      throw new Error(`${entry} instrumented MTS does not contain the N1 marker.`);
    }
    fs.writeFileSync(outputPath, instrumentedBytes);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const receipt = {
      protocol: ISSUE45_N1_PROTOCOL,
      kind: 'octane-mts-prefix-receipt',
      createdAt: new Date().toISOString(),
      entry,
      source: {
        repository: entry === 'octane-hux' ? 'Huxpro/octane' : 'octanejs/octane',
        commit,
        dirty: execFileSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' }).trim() !== '',
      },
      rows,
      build: {
        core,
        blockMode: core === 'block' ? 'scoped' : null,
        distTag: tag || null,
      },
      deviceMessageChannelFallback: {
        applied: true,
        placement: nativeFallbackViaBuild ? 'staged BTS source via build script' : 'BTS app source before staging',
        anchor: UPSTREAM_MESSAGECHANNEL_ANCHOR,
        replacement: UPSTREAM_MESSAGECHANNEL_FALLBACK,
        sha256: sha256(UPSTREAM_MESSAGECHANNEL_FALLBACK),
      },
      promiseAllSettledPolyfill: {
        placement: 'after the unique injected-runtime Promise alias in background JS, before TASM encoding',
        sha256: sha256(btsCompatPrefix),
        source: btsCompatPrefix,
        markerPresentInFinalBundle: true,
      },
      injection: {
        placement: 'MTS asset prefix before TASM encoding',
        sha256: sha256(prefix),
        source: prefix,
      },
      vendored: {
        path: vendoredPath,
        bytes: vendoredBytes.length,
        sha256: sha256(vendoredBytes),
        mtsSha256: sha256(vendoredMts),
      },
      cleanBuild: {
        bytes: baselineBytes.length,
        sha256: sha256(baselineBytes),
        mtsSha256: sha256(baselineMts),
        mtsByteExactWithVendored,
        compilerEquivalence,
      },
      bundle: {
        path: outputPath,
        bytes: instrumentedBytes.length,
        sha256: sha256(instrumentedBytes),
        markerPresent: true,
      },
    };
    fs.writeFileSync(`${outputPath}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { command, values } = parseCli(process.argv.slice(2));
  const rows = Number(values.rows);
  let receipt;
  if (command === 'build-n0') {
    if (!values['octane-root'] || !values.out) throw new Error('build-n0 requires --octane-root and --out.');
    receipt = buildIssue45N0Bundle({
      octaneRoot: values['octane-root'],
      rows,
      output: values.out,
      quiet: values.quiet,
    });
  } else if (command === 'build-react-n1') {
    if (!values['react-root'] || !values.vendored || !values.out) {
      throw new Error('build-react-n1 requires --react-root, --vendored, and --out.');
    }
    receipt = deriveVendoredReactN1Bundle({
      sourceRoot: values['react-root'],
      vendoredBundle: values.vendored,
      rows,
      output: values.out,
      quiet: values.quiet,
    });
  } else if (command === 'build-octane-n1') {
    if (!values['octane-root'] || !values.entry || !values.vendored || !values.out) {
      throw new Error('build-octane-n1 requires --octane-root, --entry, --vendored, and --out.');
    }
    receipt = buildIssue45N1OctaneBundle({
      octaneRoot: values['octane-root'],
      entry: values.entry,
      vendoredBundle: values.vendored,
      rows,
      output: values.out,
      core: values.core ?? 'universal',
      quiet: values.quiet,
    });
  } else {
    throw new Error('usage: issue45-native-probe.mjs <build-n0|build-octane-n1|build-react-n1> [options]');
  }
  console.log(JSON.stringify(receipt.bundle));
}
