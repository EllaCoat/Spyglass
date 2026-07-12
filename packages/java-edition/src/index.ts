import * as core from '@spyglassmc/core'
import * as json from '@spyglassmc/json'
import * as mcdoc from '@spyglassmc/mcdoc'
import * as nbt from '@spyglassmc/nbt'
import { jeFileUriPredicate, registerUriBuilders, uriBinder } from './binder/index.js'
import type { McmetaSummary } from './dependency/index.js'
import {
	getMcmetaSummary,
	getVanillaDatapack,
	getVanillaMcdoc,
	getVanillaResourcepack,
	getVersions,
	resolveConfiguredVersion,
	symbolRegistrar,
} from './dependency/index.js'
import * as jeJson from './json/index.js'
import { registerMcdocAttributes, registerPackFormatAttribute } from './mcdocAttributes.js'
import * as jeMcf from './mcfunction/index.js'
import { getPackFormatContext, getProjectPacks } from './packFormat.js'

export * as binder from './binder/index.js'
export * as dependency from './dependency/index.js'
export * as json from './json/index.js'
export * from './mcdocAttributes.js'
export * as mcf from './mcfunction/index.js'
export * from './packFormat.js'

export const initialize: core.ProjectInitializer = async (ctx) => {
	const { config, externals, logger, meta } = ctx

	meta.registerUriBinder(uriBinder)
	registerUriBuilders(meta)

	const [versions, packs] = await Promise.all([
		getVersions(externals, logger),
		getProjectPacks(ctx),
	])
	const packFormatContext = getPackFormatContext(packs)
	if (!versions) {
		ctx.logger.error(
			'[je-initialize] Failed loading game version list. Expect everything to be broken.',
		)
		return packFormatContext
	}

	const version = resolveConfiguredVersion(config.env.gameVersion, versions, packs, logger)
	const release = version.release

	meta.registerDependencyProvider(
		'@vanilla-datapack',
		() => getVanillaDatapack(externals, logger, version.id),
	)

	meta.registerDependencyProvider(
		'@vanilla-resourcepack',
		() => getVanillaResourcepack(externals, logger, version.id),
	)

	meta.registerDependencyProvider('@vanilla-mcdoc', () => getVanillaMcdoc(externals, logger))

	const summary = await getMcmetaSummary(
		ctx.externals,
		logger,
		version.id,
		config.env.mcmetaSummaryOverrides,
	)
	if (!summary.blocks || !summary.commands || !summary.fluids || !summary.registries) {
		ctx.logger.error(
			'[je-initialize] Failed loading mcmeta summaries. Expect everything to be broken.',
		)
		return packFormatContext
	}

	meta.registerSymbolRegistrar('mcmeta-summary', {
		checksum: `${summary.checksum}-v4`,
		registrar: symbolRegistrar(summary as McmetaSummary, release),
	})

	meta.registerLinter('nameOfNbtKey', {
		configValidator: core.linter.configValidator.nameConvention,
		linter: core.linter.nameConvention('value'),
		nodePredicate: (n) =>
			// nbt compound keys without mcdoc definition.
			(!n.symbol
				&& n.parent?.parent?.type === 'nbt:compound'
				&& core.PairNode.is(n.parent)
				&& n.type === 'string'
				&& n.parent.key === n) // nbt path keys without mcdoc definition.
			|| (!n.symbol && n.parent?.type === 'nbt:path' && n.type === 'string') // mcdoc compound key definition outside of `::minecraft` modules.
			|| (mcdoc.StructFieldNode.is(n.parent)
				&& mcdoc.StructKeyNode.is(n)
				&& !n.symbol?.path[0]?.startsWith('::minecraft')),
	})

	registerMcdocAttributes(meta, summary.commands, release)
	registerPackFormatAttribute(meta, versions, packs)

	meta.registerLanguage('zip', { extensions: ['.zip'], uriPredicate: jeFileUriPredicate })
	meta.registerLanguage('png', { extensions: ['.png'], uriPredicate: jeFileUriPredicate })
	meta.registerLanguage('ogg', { extensions: ['.ogg'], uriPredicate: jeFileUriPredicate })
	meta.registerLanguage('ttf', { extensions: ['.ttf'], uriPredicate: jeFileUriPredicate })
	meta.registerLanguage('otf', { extensions: ['.otf'], uriPredicate: jeFileUriPredicate })
	meta.registerLanguage('fsh', { extensions: ['.fsh'], uriPredicate: jeFileUriPredicate })
	meta.registerLanguage('vsh', { extensions: ['.vsh'], uriPredicate: jeFileUriPredicate })

	json.getInitializer(jeFileUriPredicate)(ctx)
	jeJson.initialize(ctx)
	jeMcf.initialize(ctx, summary.commands, release)
	nbt.initialize(ctx)

	return { loadedVersion: release, errorSource: release, ...packFormatContext }
}
