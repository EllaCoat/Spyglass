import * as core from '@spyglassmc/core'
import { getLegacyCategorySpec } from './categories.js'

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

/**
 * Canonical declaration key matching v3: only namespaced families are
 * canonicalized, while every other non-empty declaration ID remains lossless.
 */
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
	return raw
}

/**
 * Canonical symbol-table key for a parsed legacy declaration. The AST keeps
 * v3's lossless spelling for non-namespaced families, while categories served
 * by v4 resource-location consumers use the same default-namespace expansion
 * as those consumers when they enter the symbol table.
 */
export function canonicalizeLegacyDeclarationSymbolName(
	category: string,
	raw: string,
): string | undefined {
	const name = canonicalizeLegacyDeclarationName(category, raw)
	if (name === undefined) {
		return undefined
	}
	return getLegacyCategorySpec(category)?.consumerKind === 'resource-location'
		? core.ResourceLocation.lengthen(name)
		: name
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
