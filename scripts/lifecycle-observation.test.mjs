import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compactAcknowledgement,
  validateLifecycleCycles,
} from './lifecycle-observation.mjs';

test('compact acknowledgement exposes unexpected handle payload members', () => {
  assert.deepEqual(compactAcknowledgement('[1,7,3,9]'), {
    opcode: 7,
    root: 3,
    version: 9,
    tupleLength: 4,
    handlePayloadMembers: 0,
  });
  assert.equal(compactAcknowledgement('[1,3,3,9,[]]'), null);
  assert.equal(compactAcknowledgement('!octane-lynx-frame:1:0:2:x'), null);
  assert.equal(compactAcknowledgement('not json'), null);
});

test('twenty lifecycle cycles return records, listeners, and handles to baseline', () => {
  const cycles = Array.from({ length: 20 }, (_, index) => ({
    cycle: index + 1,
    rows: 1000,
    afterCreate: { rows: 1000, selectedId: index + 1, physicalHostElements: 4019 },
    afterClear: { rows: 0, selectedId: null, physicalHostElements: 19 },
    activeListenerDeliveries: 1,
    staleListenerDeliveriesAccepted: 0,
    acknowledgements: [
      { opcode: 7, handlePayloadMembers: 0 },
      { opcode: 8, handlePayloadMembers: 0 },
    ],
  }));
  assert.deepEqual(validateLifecycleCycles(cycles), {
    cycles: 20,
    physicalHostBaseline: 19,
    staleListenerDeliveriesAccepted: 0,
    acknowledgementHandlePayloadMembers: 0,
  });
  cycles[19].afterClear.physicalHostElements++;
  assert.throws(() => validateLifecycleCycles(cycles), /live records/);
});
