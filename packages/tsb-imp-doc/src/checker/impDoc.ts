import * as core from '@spyglassmc/core'
import type { ImpDocNode } from '../node/ImpDocNode.js'

function getCurrentFunctionSymbol(
	ctx: core.CheckerContext,
): core.Symbol | undefined {
	let ans: core.Symbol | undefined
	core.SymbolUtil.forEachSymbol(ctx.symbols.global, (symbol) => {
		if (
			!ans
			&& symbol.category === 'function'
			&& symbol.definition?.some(location => location.uri === ctx.doc.uri)
		) {
			ans = symbol
		}
	})
	return ans
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
