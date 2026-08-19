import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./audit-new-lynx-campaign.mjs', import.meta.url).pathname;

test('campaign audit fails closed and lists every missing required artifact', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'new-lynx-audit-'));
  try {
    const result = spawnSync(process.execPath, [script, empty], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    for (const name of [
      'window.json', 'new2-head-receipt.json', 'new1-web-run.json', 'new1-native-run.json',
      'new2-web-run.json', 'new2-native-run.json',
    ]) assert.match(result.stderr, new RegExp(name.replace('.', '\\.')));
    assert.match(result.stderr, /missing entries\/octane-new1\/entry.json/);
    assert.match(result.stderr, /missing entries\/octane-new2\/entry.json/);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
