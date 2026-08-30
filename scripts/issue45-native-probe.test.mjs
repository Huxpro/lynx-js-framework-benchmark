import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ISSUE45_N0_MARKER,
  ISSUE45_N1_MARKER,
  ISSUE45_PAPI_METHODS,
  makeIssue45N0MtsPrefix,
  makeIssue45N1MtsPrefix,
  makeIssue45BtsCompatPrefix,
  patchOctaneConfigForIssue45,
  patchReactConfigForIssue45,
  patchUpstreamMessageChannelForIssue45,
} from './issue45-native-probe.mjs';

test('N0 prefix probes each PAPI binding directly and records all clock candidates', () => {
  const source = makeIssue45N0MtsPrefix({ rows: 100 });
  assert.match(source, new RegExp(ISSUE45_N0_MARKER));
  assert.match(source, /clock\('Date\.now'/);
  assert.match(source, /clock\('performance\.now'/);
  assert.match(source, /clock\('lynx\.performance\.now'/);
  assert.match(source, /monotonicObserved/);
  assert.match(source, /resolutionMs/);
  for (const method of ISSUE45_PAPI_METHODS) {
    assert.match(source, new RegExp(`typeof ${method} === 'function'`));
    assert.match(source, new RegExp(`${method} = __issue45_wrapper_`));
  }
});

test('N1 prefix is count-only and entry-specific', () => {
  const source = makeIssue45N1MtsPrefix({ entry: 'react', rows: 1000 });
  assert.match(source, new RegExp(ISSUE45_N1_MARKER));
  assert.match(source, /entry: "react"/);
  assert.match(source, /rows: 1000/);
  assert.doesNotMatch(source, /Date\.now|performance\.now|lynx\.performance/);
  for (const method of ISSUE45_PAPI_METHODS) {
    assert.match(source, new RegExp(`${method} = __issue45_wrapper_`));
  }
});

test('Octane config patch prefixes the MTS asset at the beforeEncode seam', () => {
  const input = `import { defineConfig } from '@lynx-js/rspeedy';\n\nexport default defineConfig(() => {\n\treturn {\n\t\tsource: {\n\t\t},\n\t};\n});\n`;
  const output = patchOctaneConfigForIssue45(input);
  assert.match(output, /LynxTemplatePlugin\.getLynxTemplatePluginHooks/);
  assert.match(output, /hooks\.beforeEncode\.tapPromise/);
  assert.match(output, /prefix \+ '\\n' \+ root\.source\.source\(\)\.toString\(\)/);
  assert.match(output, /plugins: \[new Issue45MtsPrefixPlugin\(\)\]/);
  assert.match(output, /Object\.keys\(manifest\).*background/);
  assert.match(output, /BENCH_ISSUE45_BTS_PREFIX_BASE64/);
});

test('ReactLynx config patch prefixes the same beforeEncode MTS asset', () => {
  const input = `import { pluginReactLynx } from '@lynx-js/react-rsbuild-plugin';\nimport { defineConfig } from '@lynx-js/rspeedy';\n\nexport default defineConfig({\n  plugins: [pluginReactLynx()],\n});\n`;
  const output = patchReactConfigForIssue45(input);
  assert.match(output, /LynxTemplatePlugin\.getLynxTemplatePluginHooks/);
  assert.match(output, /hooks\.beforeEncode\.tapPromise/);
  assert.match(output, /tools: \{ rspack: \{ plugins: \[new Issue45MtsPrefixPlugin\(\)\] \} \}/);
  assert.match(output, /plugins: \[pluginReactLynx\(\)\]/);
});

test('upstream device fallback removes the unavailable MessageChannel constructor', () => {
  const output = patchUpstreamMessageChannelForIssue45(
    'const _stormChannel = new MessageChannel();\n_stormChannel.port2.postMessage(0);',
  );
  assert.doesNotMatch(output, /new MessageChannel/);
  assert.match(output, /setTimeout\(\(\) => _stormChannel\.port1\.onmessage\?\.\(\), 0\)/);
  assert.match(output, /postMessage\(value: number\)/);
});

test('BTS compatibility prefix only polyfills Promise.allSettled', () => {
  const output = makeIssue45BtsCompatPrefix();
  assert.match(output, /__ISSUE45_PROMISE__\.allSettled/);
  assert.match(output, /__ISSUE45_PROMISE__\.all\(Array\.from/);
  assert.doesNotMatch(output, /__CreateView|Date\.now/);
});
