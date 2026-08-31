export function shouldCollectAfterRun(args = {}) {
  return !args['no-collect'];
}
