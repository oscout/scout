import type { RuntimeRegistrySnapshot } from './registry.js';

/** Copy only the requested registry maps, preserving snapshot membership across
 * awaits. Records retain the same shallow identity as runtime.snapshot(). */
export function captureRegistries<K extends keyof RuntimeRegistrySnapshot>(
  runtime: { snapshot(): RuntimeRegistrySnapshot; peek?(): Readonly<RuntimeRegistrySnapshot> },
  keys: readonly K[],
): Pick<RuntimeRegistrySnapshot, K> {
  const source = runtime.peek?.() ?? runtime.snapshot();
  return Object.fromEntries(keys.map(key => [key, { ...source[key] }])) as Pick<RuntimeRegistrySnapshot, K>;
}
