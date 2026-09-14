export function compactAcknowledgement(value) {
  if (typeof value !== 'string' || value.startsWith('!octane-lynx-frame:')) return null;
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded[0] !== 1 || (decoded[1] !== 7 && decoded[1] !== 8)) {
    return null;
  }
  return {
    opcode: decoded[1],
    root: decoded[2],
    version: decoded[3],
    tupleLength: decoded.length,
    handlePayloadMembers: Math.max(0, decoded.length - 4),
  };
}

export function validateLifecycleCycles(cycles, expectedCount = 20) {
  if (!Array.isArray(cycles) || cycles.length !== expectedCount) {
    throw new Error(`lifecycle audit requires exactly ${expectedCount} completed cycles.`);
  }
  const baseline = cycles[0].afterClear.physicalHostElements;
  for (const cycle of cycles) {
    if (cycle.afterCreate.rows !== cycle.rows) {
      throw new Error(`cycle ${cycle.cycle} did not create ${cycle.rows} rows.`);
    }
    if (cycle.afterCreate.selectedId == null || cycle.activeListenerDeliveries !== 1) {
      throw new Error(`cycle ${cycle.cycle} did not prove its fresh row listener.`);
    }
    if (
      cycle.afterClear.rows !== 0
      || cycle.afterClear.selectedId !== null
      || cycle.afterClear.physicalHostElements !== baseline
    ) {
      throw new Error(`cycle ${cycle.cycle} did not return live records to baseline.`);
    }
    if (cycle.staleListenerDeliveriesAccepted !== 0) {
      throw new Error(`cycle ${cycle.cycle} accepted a stale row listener.`);
    }
    if (
      cycle.acknowledgements.length < 2
      || !cycle.acknowledgements.some(({ opcode }) => opcode === 7)
      || !cycle.acknowledgements.some(({ opcode }) => opcode === 8)
      || cycle.acknowledgements.some(({ handlePayloadMembers }) => handlePayloadMembers !== 0)
    ) {
      throw new Error(`cycle ${cycle.cycle} lacks a handle-free clear acknowledgement.`);
    }
  }
  return {
    cycles: cycles.length,
    physicalHostBaseline: baseline,
    staleListenerDeliveriesAccepted: cycles.reduce(
      (sum, cycle) => sum + cycle.staleListenerDeliveriesAccepted,
      0,
    ),
    acknowledgementHandlePayloadMembers: cycles.reduce(
      (sum, cycle) => sum + cycle.acknowledgements.reduce(
        (ackSum, acknowledgement) => ackSum + acknowledgement.handlePayloadMembers,
        0,
      ),
      0,
    ),
  };
}
