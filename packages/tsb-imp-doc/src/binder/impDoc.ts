import * as core from '@spyglassmc/core'
import type { ImpDocNode } from '../node/ImpDocNode.js'
import { ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import { parseVisibility, stampVisibility } from '../util/withinPattern.js'

/**
 * URI binder が登録した function symbol の parentMap から直接引く。
 * `SymbolUtil.forEachSymbol` で global symbol table 全走査するのは O(N_all_symbols)
 * per impDoc node で、 Asset 規模 (16094 file × 10000+ symbol) では bind time の
 * 半分を占める hotspot になる。 function category だけ走査する形に絞る。
 */
function getCurrentFunctionSymbol(
	ctx: core.BinderContext,
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
 * Stamp visibility metadata on the enclosing function symbol during bind phase.
 * Project.ready() binds every file before any file is checked, so external
 * callers observe the target's visibility regardless of open-order.
 * ID mismatch diagnostic remains in checker phase (need per-node ctx.err).
 */
export const impDoc = core.AsyncBinder.create<ImpDocNode>(async (node, ctx) => {
	const parsedID = node.functionID?.raw
	const currentFunction = getCurrentFunctionSymbol(ctx)

	if (
		parsedID
		&& (!currentFunction || currentFunction.identifier === parsedID)
	) {
		const symbol = ctx.symbols
			.lookup('function', [parsedID], node)
			.symbol
		if (symbol) {
			const visibility = parseVisibility(node.annotations, parsedID, ctx.err)
				?? { type: 'public' as const }

			node.symbol = symbol
			node.visibility = visibility
			symbol.desc = ImpDocNodeUtil.getDescription(node)
			stampVisibility(symbol, visibility)
		}
	}

	// impDoc binder を明示登録すると fallback は impDoc で停止するため、
	// declaration + attached mcfunction command node の binder を明示 dispatch する。
	for (const child of node.children ?? []) {
		if (ctx.meta.hasBinder(child.type)) {
			const childBinder = ctx.meta.getBinder(child.type)
			const result = childBinder(child, ctx)
			if (result instanceof Promise) {
				await result
			}
		}
	}
})
