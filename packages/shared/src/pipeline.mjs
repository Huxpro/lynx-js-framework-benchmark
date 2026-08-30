// Framework-neutral element-pipeline vocabulary. These are synchronous
// ElementPAPI host calls, not browser style/layout/paint phases.
export const PAPI_SEGMENTS = [
  'create',
  'props',
  'events',
  'topology',
  'read',
  'flush',
];

/** Classify every ElementPAPI into one stable, framework-neutral segment. */
export function classifyPapiMethod(name) {
  if (name === '__FlushElementTree') return 'flush';
  if (name.startsWith('__Create')) return 'create';
  if (['__AddEvent', '__GetEvent', '__GetEvents', '__SetEvents'].includes(name)) return 'events';
  if ([
    '__AppendElement',
    '__InsertElementBefore',
    '__RemoveElement',
    '__ReplaceElement',
    '__ReplaceElements',
    '__SwapElement',
  ].includes(name)) return 'topology';
  if (
    name.startsWith('__Get')
    || name.startsWith('__Query')
    || name.startsWith('__First')
    || name.startsWith('__Last')
    || name.startsWith('__Next')
    || name === '__ElementIsEqual'
  ) return 'read';
  // Attributes, classes, styles, data/config, animation, list callbacks,
  // component metadata, IDs, template markers, and UI-method invocation all
  // mutate or configure an existing element and share the props bucket.
  return 'props';
}
