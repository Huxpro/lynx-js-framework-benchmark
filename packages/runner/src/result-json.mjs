const CLIENT_ID = /\bclientId:\s*\S+/g;
const SANDBOX_SERIAL = /(\bsandbox\s+)(?:[a-zA-Z0-9-]+\.)+[a-zA-Z0-9-]+:\d+/g;

export function redactResultString(value) {
  return value
    .replace(CLIENT_ID, 'clientId: [redacted]')
    .replace(SANDBOX_SERIAL, '$1[redacted]');
}

export function stringifyResult(value) {
  return JSON.stringify(
    value,
    (_key, candidate) => typeof candidate === 'string'
      ? redactResultString(candidate)
      : candidate,
    1,
  );
}
