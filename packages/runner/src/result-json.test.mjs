import assert from 'node:assert/strict';
import test from 'node:test';

import { redactResultString, stringifyResult } from './result-json.mjs';

test('result serialization redacts DevTool client IDs at every nesting level', () => {
  const message = 'No response found for clientId: internal.example%3A1234:8901';
  assert.equal(
    redactResultString(`Error: ${message}`),
    'Error: No response found for clientId: [redacted]',
  );

  const serialized = stringifyResult({
    message,
    evidence: {
      recoveries: [{ message: `Error: ${message}` }],
    },
    safe: 'No response found without a client identifier',
  });
  assert.equal(serialized.includes('internal.example'), false);
  assert.deepEqual(JSON.parse(serialized), {
    message: 'No response found for clientId: [redacted]',
    evidence: {
      recoveries: [{ message: 'Error: No response found for clientId: [redacted]' }],
    },
    safe: 'No response found without a client identifier',
  });
});

test('result serialization redacts sandbox serials from failure messages', () => {
  const message = 'Lynx Explorer did not reconnect on sandbox device.example.net:30602.';
  assert.equal(
    redactResultString(`Error: ${message}`),
    'Error: Lynx Explorer did not reconnect on sandbox [redacted].',
  );

  const serialized = stringifyResult({ failures: [{ message }] });
  assert.equal(serialized.includes('device.example.net'), false);
  assert.deepEqual(JSON.parse(serialized), {
    failures: [{ message: 'Lynx Explorer did not reconnect on sandbox [redacted].' }],
  });
});
