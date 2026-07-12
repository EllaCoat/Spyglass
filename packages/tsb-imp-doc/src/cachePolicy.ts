import { ImpDocVersion } from './version.js'

/** Initializer-context key owned by the tsb-imp-doc plugin. */
export const ImpDocCacheContextKey = 'plugin:@spyglassmc/tsb-imp-doc'

/**
 * Return the fork-specific initializer fingerprint consumed by core's generic
 * component-hash invalidation mechanism.
 */
export function getImpDocCacheContext(
	version: string = ImpDocVersion,
): Record<typeof ImpDocCacheContextKey, string> {
	return { [ImpDocCacheContextKey]: version }
}
