import * as core from '@spyglassmc/core'
import { formatContractHoverDescription } from '../hover/contract.js'
import type { ImpDocNode } from '../node/ImpDocNode.js'
import { ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import { parseVisibility, stampVisibility } from '../util/withinPattern.js'
import { bindContract, getCurrentFunctionSymbol } from './contract.js'

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
			stampVisibility(symbol, visibility)
			bindContract(node, ctx, symbol)
			symbol.desc = formatContractHoverDescription(
				symbol.identifier,
				visibility,
				node.contract,
				ImpDocNodeUtil.getDescription(node),
			)
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
