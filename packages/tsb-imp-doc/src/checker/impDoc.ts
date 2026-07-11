import * as core from '@spyglassmc/core'
import type { ImpDocNode } from '../node/ImpDocNode.js'

/**
 * URI binder が登録した function symbol の parentMap から直接引く。
 * `SymbolUtil.forEachSymbol` で global symbol table 全走査するのは O(N_all_symbols)
 * per impDoc node で、 Asset 規模 (16094 file × 10000+ symbol) では check time の
 * 半分を占める hotspot になる。 function category だけ走査する形に絞る。
 */
function getCurrentFunctionSymbol(
	ctx: core.CheckerContext,
): core.Symbol | undefined {
	const functions = ctx.symbols.lookup('function', []).parentMap
	for (const symbol of Object.values(functions ?? {})) {
		if (
			symbol
			&& symbol.definition?.some(location => location.uri === ctx.doc.uri)
		) {
			return symbol
		}
	}
	return undefined
}

/**
 * Visibility stamp は binder phase (`binder/impDoc.ts`) に移行済み。
 * checker には functionID mismatch diagnostic と child checker dispatch のみ残す。
 */
export const impDoc: core.Checker<ImpDocNode> = async (node, ctx) => {
	const parsedID = node.functionID?.raw
	const currentFunction = getCurrentFunctionSymbol(ctx)

	if (parsedID && currentFunction && parsedID !== currentFunction.identifier) {
		ctx.err.report(
			`Expected function ID “${currentFunction.identifier}”, got “${parsedID}”`,
			node.functionID!,
		)
	}

	for (const child of node.children ?? []) {
		if (ctx.meta.hasChecker(child.type)) {
			await ctx.meta.getChecker(child.type)(child, ctx)
		}
	}
}
