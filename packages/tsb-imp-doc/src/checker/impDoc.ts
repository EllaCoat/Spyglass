import * as core from '@spyglassmc/core'
import type { ImpDocNode } from '../node/ImpDocNode.js'
import { ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import { parseVisibility, stampVisibility } from '../util/withinPattern.js'

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

export const impDoc: core.Checker<ImpDocNode> = async (node, ctx) => {
	const parsedID = node.functionID?.raw
	const currentFunction = getCurrentFunctionSymbol(ctx)

	if (parsedID && currentFunction && parsedID !== currentFunction.identifier) {
		ctx.err.report(
			`Expected function ID “${currentFunction.identifier}”, got “${parsedID}”`,
			node.functionID!,
		)
	}

	// declaration doc (functionID なし) や ID mismatch header doc は
	// function symbol の visibility を更新しない。
	// これで _index.d の「@private header + @public declaration doc」 layout での
	// stamp → un-stamp 事故を防ぐ (= P1a で characterize 済み)。
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

			node.visibility = visibility
			node.symbol = symbol
			symbol.desc = ImpDocNodeUtil.getDescription(node)
			stampVisibility(symbol, visibility)
		}
	}

	for (const child of node.children ?? []) {
		if (ctx.meta.hasChecker(child.type)) {
			await ctx.meta.getChecker(child.type)(child, ctx)
		}
	}
}
