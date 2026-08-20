const CLIENT_ID = /\bclientId:\s*\S+/g;

export function redactResultString(value) {
  return value.replace(CLIENT_ID, 'clientId: [redacted]');
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
