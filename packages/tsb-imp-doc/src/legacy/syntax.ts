import * as core from '@spyglassmc/core'
import { getLegacyCategorySpec } from './categories.js'

const PlainIdentifierPattern = /^[0-9A-Za-z_.+-]+$/
const ScoreHolderPattern = /^\$[0-9A-Za-z_.+^-]+$/

/**
 * Reproduces v3 `IdentityNode.fromString(raw).toString()` for declaration IDs.
 *
 * Unlike the v4 resource-location helper, v3 strips one leading tag marker,
 * treats an empty namespace as the default namespace, and ignores every colon
 * after the first namespace/path separator.
 */
export function canonicalizeLegacyNamespacedId(raw: string): string {
	const value = raw.startsWith(core.ResourceLocation.TagPrefix)
		? raw.slice(core.ResourceLocation.TagPrefix.length)
		: raw
	const parts = value.split(core.ResourceLocation.NamespacePathSep)
	if (parts.length === 1) {
		return core.ResourceLocation.lengthen(value)
	}
	return `${parts[0] || core.ResourceLocation.DefaultNamespace}`
		+ `${core.ResourceLocation.NamespacePathSep}${parts[1]}`
}

/** Canonical declaration key, retaining the v3 validation rules per family. */
export function canonicalizeLegacyDeclarationName(
	category: string,
	raw: string,
): string | undefined {
	const spec = getLegacyCategorySpec(category)
	if (!spec || spec.family === 'alias' || !raw) {
		return undefined
	}
	if (spec.family === 'namespaced') {
		return canonicalizeLegacyNamespacedId(raw)
	}
	if (spec.family === 'entity-like') {
		return (spec.id === 'score_holder'
				? ScoreHolderPattern
				: PlainIdentifierPattern).test(raw)
			? raw
			: undefined
	}
	return PlainIdentifierPattern.test(raw) ? raw : undefined
}

export interface LegacyAliasNameParserContext {
	err: core.ErrorReporter
}

/**
 * Reads the v3 alias-name token grammar using the fork's Brigadier string
 * parser. The returned value is decoded while its range still spans the source
 * token, including quotes.
 */
export function parseLegacyAliasNameToken(
	src: core.Source,
	ctx: LegacyAliasNameParserContext,
): core.StringNode | undefined {
	const errorCount = ctx.err.errors.length
	const node = core.brigadierString(src, ctx as core.ParserContext)
	return ctx.err.errors.length === errorCount && node.range.end > node.range.start
		? node
		: undefined
}
