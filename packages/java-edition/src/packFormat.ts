import * as core from '@spyglassmc/core'
import type { PackInfo } from './dependency/index.js'
import { PackMcmeta } from './dependency/index.js'

export const PackFormatContextKey = 'java-edition:pack-formats'

function isPackMcmeta(uri: string): boolean {
	return uri.endsWith('/pack.mcmeta')
}

/**
 * Discover pack formats that affect Java Edition initialization and register
 * `pack.mcmeta` as a project-level reinitialization input.
 */
export async function getProjectPacks(
	ctx: core.ProjectInitializerContext,
): Promise<PackInfo[]> {
	const { externals, logger, projectRoots } = ctx
	ctx.reinitializeOnChange(isPackMcmeta)

	async function readPackFormat(uri: string): Promise<number | undefined> {
		try {
			const data = await core.fileUtil.readJson(externals, uri)
			return PackMcmeta.readPackFormat(data)
		} catch (e) {
			if (!externals.error.isKind(e, 'ENOENT')) {
				// `pack.mcmeta` exists but is broken. Log an error.
				logger.error(`[je.initialize] Failed loading pack.mcmeta ${uri}`, e)
			}
		}
		return undefined
	}

	const packs: PackInfo[] = []
	const packMcmetaUris = new Set(
		(await Promise.all(projectRoots.map(root => core.fileUtil.getAllFiles(externals, root))))
			.flat()
			.filter(isPackMcmeta),
	)
	for (const uri of packMcmetaUris) {
		const packRoot = core.fileUtil.dirname(uri)
		const [format, type] = await Promise.all([
			readPackFormat(uri),
			PackMcmeta.getType(packRoot, externals),
		])
		if (format !== undefined) {
			packs.push({ type, packRoot, format })
		}
	}
	return packs
}

/** A stable initializer context component for Java Edition pack formats. */
export function getPackFormatContext(packs: readonly PackInfo[]): Record<string, string> {
	const normalized = packs
		.map(({ format, packRoot, type }) => ({ format, packRoot, type }))
		.sort((a, b) =>
			a.packRoot.localeCompare(b.packRoot)
			|| a.type.localeCompare(b.type)
			|| a.format - b.format
		)
	return { [PackFormatContextKey]: JSON.stringify(normalized) }
}
