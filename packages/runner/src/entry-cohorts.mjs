import { entrySupportsHarness } from './entries.mjs';

/**
 * Resolve the current published cohort for one harness. Per-harness tiers are
 * an all-or-nothing cohort switch: once any supported entry declares a tier
 * for that harness, legacy global tiers no longer leak into that harness.
 */
export function featuredEntriesForHarness(entries, harness) {
  const supported = entries.filter((entry) => entrySupportsHarness(entry, harness));
  const hasHarnessTiers = supported.some((entry) => entry.tiers?.[harness] != null);
  return supported.filter((entry) => {
    const tier = hasHarnessTiers ? entry.tiers?.[harness] : (entry.tier ?? 'featured');
    return tier === 'featured';
  });
}
