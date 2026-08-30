// Static harness server: serves web-core, entry bundles, the harness page,
// and the worker-side instrument. COOP/COEP headers keep the rpc's
// SharedArrayBuffer sync path working, matching real deployments.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  DRIVER_CLIENT_JS,
  LIST_DRIVER_CLIENT_JS,
  PIPELINE_DRIVER_CLIENT_JS,
  STORM_DRIVER_CLIENT_JS,
} from '@lynx-bench/shared/driver-client';
import {
  PAGE_INSTRUMENT_JS,
  PAPI_PAGE_INSTRUMENT_JS,
  WORKER_INSTRUMENT_JS,
} from '@lynx-bench/shared/page-instrument';

const require = createRequire(import.meta.url);

export function webCoreRoot() {
  // client_prod is the production build web-core ships for CDN use.
  const pkg = require.resolve('@lynx-js/web-core/package.json');
  return path.join(path.dirname(pkg), 'dist/client_prod');
}

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.bundle': 'application/octet-stream',
};

export function makeHarnessHtml({ pipeline = false, storm = false, list = false } = {}) {
  if ([pipeline, storm, list].filter(Boolean).length > 1) {
    throw new Error('special harness modes are mutually exclusive');
  }
  const driver = pipeline
    ? PIPELINE_DRIVER_CLIENT_JS
    : storm ? STORM_DRIVER_CLIENT_JS : list ? LIST_DRIVER_CLIENT_JS : DRIVER_CLIENT_JS;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script>${PAGE_INSTRUMENT_JS}</script>
  ${pipeline ? `<script>${PAPI_PAGE_INSTRUMENT_JS}</script>` : ''}
  <script>${driver}</script>
  <script type="module" src="/webcore/static/js/client.js"></script>
  <link rel="stylesheet" href="/webcore/static/css/client.css">
  <style>html,body{margin:0;padding:0}</style>
</head>
<body></body>
</html>`;
}

/**
 * @param bundleRoots map of entryId -> absolute dir containing bundle files.
 */
export async function startServer({ bundleRoots }) {
  const coreRoot = webCoreRoot();
  const harnessHtml = makeHarnessHtml();
  const pipelineHarnessHtml = makeHarnessHtml({ pipeline: true });
  const stormHarnessHtml = makeHarnessHtml({ storm: true });
  const listHarnessHtml = makeHarnessHtml({ list: true });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const headers = {
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'no-store',
    };
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end(harnessHtml);
        return;
      }
      if (url.pathname === '/pipeline' || url.pathname === '/pipeline.html') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end(pipelineHarnessHtml);
        return;
      }
      if (url.pathname === '/storm' || url.pathname === '/storm.html') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end(stormHarnessHtml);
        return;
      }
      if (url.pathname === '/list' || url.pathname === '/list.html') {
        res.writeHead(200, { ...headers, 'content-type': 'text/html' });
        res.end(listHarnessHtml);
        return;
      }
      if (url.pathname === '/instrument-worker.js') {
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript' });
        res.end(WORKER_INSTRUMENT_JS);
        return;
      }
      let filePath = null;
      if (url.pathname.startsWith('/webcore/')) {
        filePath = path.join(coreRoot, url.pathname.slice('/webcore/'.length));
      } else if (url.pathname.startsWith('/bundles/')) {
        const [, , entryId, ...rest] = url.pathname.split('/');
        const root = bundleRoots[entryId];
        if (root) filePath = path.join(root, rest.join('/'));
      }
      if (!filePath) {
        res.writeHead(404, headers);
        res.end('not found: ' + url.pathname);
        return;
      }
      const body = await readFile(filePath);
      res.writeHead(200, {
        ...headers,
        'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch (e) {
      res.writeHead(404, headers);
      res.end(String(e));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
