// Chromium resolution + launch. playwright-core carries no browser; we probe
// the Playwright cache and common system locations (same strategy as the
// unified benchmark's harnesses), and open a remote-debugging port for the
// CDP sidecar (per-realm profiling).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

export function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const candidates = [];
  const caches = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright'),
    '/opt/pw-browsers',
  ];
  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    for (const dir of fs.readdirSync(cache).sort().reverse()) {
      if (!dir.startsWith('chromium-')) continue;
      for (const sub of ['chrome-mac', 'chrome-mac-arm64']) {
        candidates.push(
          path.join(cache, dir, sub, 'Chromium.app/Contents/MacOS/Chromium'),
          path.join(cache, dir, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        );
      }
      candidates.push(
        path.join(cache, dir, 'chrome-linux/chrome'),
        path.join(cache, dir, 'chrome-linux64/chrome'),
      );
    }
  }
  candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  );
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const bin of ['chromium', 'google-chrome', 'chromium-browser']) {
    try {
      const p = execSync(`command -v ${bin}`, { stdio: 'pipe' }).toString().trim();
      if (p) return p;
    } catch { /* not found */ }
  }
  throw new Error(
    'No Chromium found. Install one with `npx playwright install chromium` or set PLAYWRIGHT_CHROMIUM_PATH.',
  );
}

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function chromiumArgs({ jit = 'jit' } = {}) {
  if (jit !== 'jit' && jit !== 'jitless') throw new Error(`invalid jit regime: ${jit}`);
  return [
    jit === 'jit'
      ? '--js-flags=--expose-gc'
      : '--js-flags=--expose-gc --jitless --wasm-jitless',
    '--enable-precise-memory-info',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
}

export async function launchBrowser({ headless = true, jit = 'jit' } = {}) {
  const executablePath = resolveChromium();
  const cdpPort = await freePort();
  const browser = await chromium.launch({
    headless,
    executablePath,
    args: [
      `--remote-debugging-port=${cdpPort}`,
      ...chromiumArgs({ jit }),
    ],
  });
  return { browser, cdpPort, executablePath, browserVersion: browser.version() };
}
