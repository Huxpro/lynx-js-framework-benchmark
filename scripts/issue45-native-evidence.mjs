#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyPapiMethod, PAPI_SEGMENTS } from '../packages/shared/src/pipeline.mjs';
import { BOUNDARIES, makeRecord, SCHEMA_VERSION } from '../packages/shared/src/schema.mjs';
import {
  ISSUE45_N0_PROTOCOL,
  ISSUE45_N1_PROTOCOL,
  ISSUE45_PAPI_METHODS,
  makeIssue45BtsCompatPrefix,
  makeIssue45N0MtsPrefix,
  makeIssue45N1MtsPrefix,
} from './issue45-native-probe.mjs';

export const ISSUE45_AUDIT_PATH = 'results/audits/2026-08-30-issue45-native-pipeline.json';
export const ISSUE45_RUN_PATH =
  'results/runs/2026-08-30T12-10-00-native-pipeline-counts.json';
export const ISSUE45_GENERATED_AT = '2026-08-30T12:10:00.000Z';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const ISSUE45_N1_COUNTS = Object.freeze({
  'octane-hux': Object.freeze({
    __CreatePage: 1,
    __GetElementUniqueID: 1,
    __CreateView: 1015,
    __SetAttribute: 4028,
    __SetClasses: 4028,
    __CreateText: 3013,
    __CreateRawText: 3013,
    __AppendElement: 7041,
    __AddEvent: 2012,
    __FlushElementTree: 1,
  }),
  octane: Object.freeze({
    __CreatePage: 1,
    __GetElementUniqueID: 1,
    __CreateView: 848,
    __SetAttribute: 3360,
    __SetClasses: 3360,
    __CreateText: 2512,
    __CreateRawText: 2512,
    __AddEvent: 1676,
    __InsertElementBefore: 5861,
  }),
  react: Object.freeze({
    __CreatePage: 1,
    __GetElementUniqueID: 1,
    __SetCSSId: 1,
    __CreateView: 1015,
    __SetClasses: 4028,
    __CreateText: 3013,
    __SetAttribute: 3013,
    __AppendElement: 6028,
    __AddEvent: 2012,
    __CreateRawText: 2000,
    __FlushElementTree: 1,
  }),
});

export const ISSUE45_WEB_ORACLE_COUNTS = Object.freeze({
  __AddEvent: 2000,
  __CreateRawText: 3000,
  __CreateText: 3000,
  __CreateView: 1000,
  __FlushElementTree: 1,
  __InsertElementBefore: 7000,
  __SetClasses: 4000,
});

export function classifyIssue45Counts(counts) {
  const segments = Object.fromEntries(PAPI_SEGMENTS.map((segment) => [segment, 0]));
  for (const [method, count] of Object.entries(counts)) {
    assert.ok(ISSUE45_PAPI_METHODS.includes(method), `unknown issue #45 PAPI method: ${method}`);
    assert.ok(Number.isSafeInteger(count) && count >= 0, `invalid count for ${method}`);
    segments[classifyPapiMethod(method)] += count;
  }
  return segments;
}

function exactMethodDiff(left, right) {
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .map((method) => [method, {
      native: left[method] ?? 0,
      web: right[method] ?? 0,
      delta: (left[method] ?? 0) - (right[method] ?? 0),
    }])
    .filter(([, values]) => values.delta !== 0));
}

function injection(entry, expectedSha256) {
  const source = makeIssue45N1MtsPrefix({ entry, rows: 1000 });
  assert.equal(sha256(source), expectedSha256);
  return {
    placement: 'MTS asset prefix before TASM encoding',
    sha256: expectedSha256,
    source,
  };
}

function bundle(bytes, hash) {
  return { bytes, sha256: hash, markerPresent: true };
}

const MESSAGE_CHANNEL_FALLBACK = Object.freeze({
  applied: true,
  placement: 'BTS app source before staging',
  anchor: 'const _stormChannel = new MessageChannel();',
  sha256: '9bdc076af5b77e8959944c3bb6af321b35f01f8493f95562eb36874ca20a136b',
});

function buildReceipts() {
  const n0Source = makeIssue45N0MtsPrefix({ rows: 100 });
  assert.equal(sha256(n0Source),
    '07bd21205bbff3c34376f107397f0ed8e9917e7c23f1d4902d556f9faac519a7');
  const btsCompatSource = makeIssue45BtsCompatPrefix();
  assert.equal(sha256(btsCompatSource),
    '3741086cf98f1e2fb6f2d47ba8a1054ebf05e9c9d51c3a5d86e3265409498993');
  const promiseAllSettledPolyfill = {
    placement: 'after the unique injected-runtime Promise alias in background JS, before TASM encoding',
    sha256: sha256(btsCompatSource),
    source: btsCompatSource,
    markerPresentInFinalBundle: true,
  };
  return {
    n0: {
      source: { repository: 'Huxpro/octane', commit: 'e9f1fb14efb0799b091c2982a89bfb72af3fd209', dirty: false },
      rows: 100,
      build: { core: 'block', blockMode: 'scoped', distTag: 'issue45-n0' },
      injection: {
        placement: 'MTS asset prefix before TASM encoding',
        sha256: sha256(n0Source),
        source: n0Source,
      },
      bundle: bundle(454349, '1da0faf5ed2b0a7b774bb1fcbc46f7c3c590339065dc5e19bec32158ff7be751'),
    },
    'octane-hux': {
      source: { repository: 'Huxpro/octane', commit: 'e9f1fb14efb0799b091c2982a89bfb72af3fd209', dirty: false },
      rows: 1000,
      build: { core: 'block', blockMode: 'scoped', distTag: 'issue45-n1-octane-hux' },
      deviceMessageChannelFallback: { ...MESSAGE_CHANNEL_FALLBACK, placement: 'staged BTS source via build script' },
      promiseAllSettledPolyfill,
      injection: injection('octane-hux', '4ba8c6825f21a9144bb8ec312c85967760e83e838391efb7f7ad3775d841ceb0'),
      vendored: {
        bytes: 444709,
        sha256: 'cf87f652cdc2844b09689f72d21dba989770c561926bbd92bb0f715da0cdcbd3',
        mtsSha256: '684a253782280c9653388169ed2d5fc118ebf7324d21290f2e3c1d9b5512c44a',
      },
      cleanBuild: { mtsByteExactWithVendored: true },
      bundle: bundle(453377, 'a604836349255455a884e01c681df833c615c57ca8bfd1ac520f773fec4a9f35'),
    },
    octane: {
      source: { repository: 'octanejs/octane', commit: 'd5175ca89fdebb8542063b265c6c84b0c7689090', dirty: false },
      rows: 1000,
      build: { core: 'universal', blockMode: null, distTag: null },
      deviceMessageChannelFallback: MESSAGE_CHANNEL_FALLBACK,
      promiseAllSettledPolyfill,
      injection: injection('octane', '6b047fbac0c9e1e3ac5873a6c850eb5001f56ab65f020ebf2074ca3caf696b3b'),
      vendored: {
        bytes: 490295,
        sha256: '4b8e839f27df63a10f8c80033d98b4b9e4dd02e7b91ecd0ebc6d69bcf76e3c4b',
        mtsSha256: '05828024879ca967093204508cca59dd658e0f08dbb2a85a570a9523c83c35d3',
      },
      cleanBuild: {
        mtsByteExactWithVendored: false,
        compilerEquivalence: {
          kind: 'generated-debug-metadata-and-alpha-rename-only',
          staticDecodedSectionsEqualVendored: true,
          mtsAlphaRename: '3<->8',
          btsAlphaRename: '3<->6',
        },
      },
      bundle: bundle(498753, '543579f2889a369ceedbe2cb6c76e02be72cffd43002979ab4a254a64dd03500'),
    },
    react: {
      source: {
        repository: 'Huxpro/vue-lynx',
        commit: '28f7acbab990b3b574f04944e0d21c769719cc68',
        exactEntryPatchSha256: 'a8745f5c560f381fcad062682cd9820b3c3a4bce6182eb10718c1bc1efaf72b1',
      },
      rows: 1000,
      injection: {
        ...injection('react', 'aa3ac9a39fd9c19a8cbf45b0462efe34356c81b34f4572ea5cef614b5ca30ba0'),
        placement: 'MTS asset prefix before TASM encoding; ROOT_LEPUS transplanted onto vendored sections',
      },
      vendored: {
        bytes: 102957,
        sha256: '893caede546f1825159ceb1c538c780c4ffafd2ea1536ef806a265164525fa34',
        mtsSha256: 'f1183fb1a1e9a2b27a66ff576b927ee35fb8f1b4d8c9f266d23727436367c3c2',
      },
      cleanBuild: { mtsByteExactWithVendored: true },
      transplant: {
        mtsPayloadOffset: 51527,
        baselineVendorDifferingByteCount: 288,
        allBaselineVendorDifferencesBeforeMts: true,
        restoredVendoredScriptBytes: 49571,
        decodedNonMtsSectionsEqualVendored: true,
      },
      bundle: bundle(110270, '1aeea8c1b870fbbc863fe14702057fdd211d240bddd0e559566036623ff383f2'),
    },
  };
}

export function makeIssue45Run() {
  const commits = {
    octane: 'd5175ca89fdebb8542063b265c6c84b0c7689090',
    'octane-hux': 'e9f1fb14efb0799b091c2982a89bfb72af3fd209',
    react: '28f7acbab990b3b574f04944e0d21c769719cc68',
  };
  const records = Object.entries(ISSUE45_N1_COUNTS).flatMap(([entry, counts]) => {
    const segments = classifyIssue45Counts(counts);
    return PAPI_SEGMENTS.map((segment) => ({
      ...makeRecord({
        suite: 'pipeline-native',
        harness: 'native',
        environment: 'lynx-native-aries10-sdk4',
        entry,
        workload: 'mount-create',
        scale: 1000,
        metric: `papi${segment[0].toUpperCase()}${segment.slice(1)}Calls`,
        boundary: BOUNDARIES.papiNativeCalls,
        unit: 'count',
        samples: [segments[segment]],
        detailSamples: [{
          requestedRows: 1000,
          committedRows: 1000,
          callMultiset: counts,
          attribution: 'whole native mount, including app shell',
        }],
      }),
      rankingEligible: false,
      comparabilityStatus: 'isolated-evidence-only',
      evidenceRef: ISSUE45_AUDIT_PATH,
    }));
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      generatedAt: ISSUE45_GENERATED_AT,
      argv: ['issue45-native-evidence'],
      machine: {
        id: 'native-attribution-27ef11fc3610',
        platform: 'android',
        deviceCohort: 'aries10-sdk4',
        serialSha256: '27ef11fc3610ecf1c723e2d6b6ac25099a1b0e487aa8508b8d535d55e651d2cd',
      },
      calibration: null,
      checkpoint: false,
      checkpointComplete: false,
      comparisonPolicy: 'isolated-count-evidence-only',
      entryCommits: commits,
      evidenceRef: ISSUE45_AUDIT_PATH,
    },
    records,
  };
}

export function makeIssue45Audit() {
  const receiptData = buildReceipts();
  const n0Bindings = Object.fromEntries(ISSUE45_PAPI_METHODS.map((method) => [method, {
    present: true, rebound: true, assignmentError: null,
  }]));
  const nativeSegments = Object.fromEntries(Object.entries(ISSUE45_N1_COUNTS)
    .map(([entry, counts]) => [entry, classifyIssue45Counts(counts)]));
  const oracleSegments = classifyIssue45Counts(ISSUE45_WEB_ORACLE_COUNTS);
  return {
    protocol: 'lynx-bench-issue45-native-pipeline-audit-v1',
    issue: 45,
    generatedAt: ISSUE45_GENERATED_AT,
    decision: {
      N0: {
        papiRebindable: true,
        next: 'N1-GO',
        highResolutionClockAvailable: false,
        timing: 'N2-NO-GO',
      },
      publication: 'counts-only',
      timingLabelReservedForFutureValidMeasurements:
        'engine + JNI bridge, as seen from Lepus',
      isolation: {
        suite: 'pipeline-native',
        mixedWithNativeRankingCohort: false,
        mixedWithWebPipelineSuite: false,
        collectorPolicy: 'dedicated descriptive outlet only; excluded from ordinary records, comparison, rankings, history, and campaign cells',
      },
    },
    device: {
      cohort: 'aries10-sdk4',
      leaseIssueId: 'issue-45-native-pipeline-n0',
      leaseExpiredAt: '2026-08-30T12:21:15.774Z',
      serialSha256: '27ef11fc3610ecf1c723e2d6b6ac25099a1b0e487aa8508b8d535d55e651d2cd',
      sharedLeaseUsedForN0AndN1: true,
    },
    N0: {
      protocol: ISSUE45_N0_PROTOCOL,
      requestedRows: 100,
      committedRows: 100,
      domPredicate: { query: 'col-label', resultCount: 100 },
      reportError: null,
      bindings: n0Bindings,
      counts: {
        __CreatePage: 1,
        __GetElementUniqueID: 2265,
        __CreateView: 230,
        __SetAttribute: 428,
        __SetClasses: 856,
        __CreateText: 626,
        __CreateRawText: 626,
        __AppendElement: 741,
        __AddEvent: 636,
        __FlushElementTree: 3,
        __GetParent: 781,
        __ElementIsEqual: 40,
        __RemoveElement: 1,
        __InsertElementBefore: 741,
      },
      clocks: {
        'Date.now': {
          available: true,
          reads: 37282,
          positiveDeltas: 40,
          equalReads: 37242,
          backwardReads: 0,
          resolutionMs: 1,
          monotonicObserved: true,
        },
        'performance.now': { available: false, error: 'not a function' },
        'lynx.performance.now': { available: false, error: 'not a function' },
      },
      clockSurface: {
        globalThis: { __date_clock: 'function', setTimeout: 'function', clearTimeout: 'function' },
        'lynx.performance': {},
      },
      buildReceipt: receiptData.n0,
    },
    N1: {
      protocol: ISSUE45_N1_PROTOCOL,
      classifier: {
        source: 'packages/shared/src/pipeline.mjs',
        import: 'classifyPapiMethod, PAPI_SEGMENTS',
        reimplemented: false,
      },
      entries: Object.fromEntries(Object.entries(ISSUE45_N1_COUNTS).map(
        ([entry, counts], index) => [entry, {
          requestedRows: 1000,
          committedRows: 1000,
          domPredicate: { query: 'col-label', resultCount: 1000 },
          devtoolSessionId: [4, 5, 6][index],
          bindings: { present: 24, rebound: 24, assignmentErrors: [] },
          reportError: null,
          consoleErrors: [],
          methodCounts: counts,
          segmentCounts: nativeSegments[entry],
          buildReceipt: receiptData[entry],
        }],
      )),
      webOracle: {
        sourceRun: 'results/runs/2026-08-30T10-54-22-65160668d8d9-issue-44-post-fix-pipeline-v2.json',
        entry: 'octane-hux',
        workload: 'create',
        scale: 1000,
        methodCounts: ISSUE45_WEB_ORACLE_COUNTS,
        segmentCounts: oracleSegments,
        equality: false,
        exactMethodDifferences: exactMethodDiff(
          ISSUE45_N1_COUNTS['octane-hux'], ISSUE45_WEB_ORACLE_COUNTS),
        explanation: 'Native captures the whole mount, including the app shell and static attributes; '
          + 'the Web oracle captures row creation after its shell exists. Native uses __AppendElement '
          + 'where the Web oracle uses __InsertElementBefore.',
      },
    },
    N2: {
      status: 'NO-GO',
      reason: 'The finest Lepus clock is monotonic Date.now() at 1 ms; performance.now and '
        + 'lynx.performance.now are unavailable. One millisecond is far coarser than an individual '
        + 'ElementPAPI call, so wrapper overhead and signal cannot be separated.',
      timingArmsRun: 0,
      timingRecordsPublished: 0,
    },
    outputs: { audit: ISSUE45_AUDIT_PATH, run: ISSUE45_RUN_PATH },
  };
}

export function writeIssue45Evidence(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const outputs = [
    [ISSUE45_AUDIT_PATH, makeIssue45Audit()],
    [ISSUE45_RUN_PATH, makeIssue45Run()],
  ];
  for (const [relativePath, value] of outputs) {
    const outputPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
  }
  return outputs.map(([relativePath]) => relativePath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const output of writeIssue45Evidence()) console.log(output);
}
