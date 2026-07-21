import * as core from '@spyglassmc/core'
import { formatContractHoverDescription } from '../hover/contract.js'
import type { ImpDocNode } from '../node/ImpDocNode.js'
import { ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import {
	fallbackVisibility,
	parseVisibility,
	stampVisibility,
	trackHeaderVisibility,
} from '../util/withinPattern.js'
import { bindContract, getCurrentFunctionSymbol } from './contract.js'

/**
 * Stamp visibility metadata on the enclosing function symbol during bind phase.
 * Project.ready() binds every file before any file is checked, so external
 * callers observe the target's visibility regardless of open-order.
 * ID mismatch diagnostic remains in checker phase (need per-node ctx.err).
 */
export const impDoc = core.AsyncBinder.create<ImpDocNode>(async (node, ctx) => {
	const parsedID = node.functionID?.raw
		? core.ResourceLocation.lengthen(node.functionID.raw)
		: undefined
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
				?? fallbackVisibility(node.annotations, parsedID, ctx.err)

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
			// Record the stamping document so the URI clear hook can purge the
			// header metadata (visibility / contract / desc) when this document
			// is deleted or rebound.
			trackHeaderVisibility(ctx.symbols, symbol, ctx.doc.uri)
		}
	}

	// impDoc binder を明示登録すると fallback は impDoc で停止するため、
	// declaration / alias + attached mcfunction command node の binder を明示 dispatch する。
	// binder 未登録 type (= `mcfunction:macro` 等) も getBinder の fallback 経由で
	// 降ろす: hasBinder guard で skip すると macro 配下に nest した参照 node が
	// 全件 unbound になり best-effort existence check が誤爆する (spike 2)。
	for (const child of node.children ?? []) {
		const childBinder = ctx.meta.getBinder(child.type)
		const result = childBinder(child, ctx)
		if (result instanceof Promise) {
			await result
		}
	}
})
