import * as core from '@spyglassmc/core'
import { getCurrentFunctionSymbol } from '../binder/contract.js'
import type { ImpDocNode } from '../node/ImpDocNode.js'
import { checkContract } from './contract.js'

/**
 * Visibility stamp は binder phase (`binder/impDoc.ts`) に移行済み。
 * checker には functionID mismatch diagnostic と child checker dispatch のみ残す。
 */
export const impDoc: core.Checker<ImpDocNode> = async (node, ctx) => {
	checkContract(node, ctx)

	const parsedID = node.functionID?.raw
		? core.ResourceLocation.lengthen(node.functionID.raw)
		: undefined
	const currentFunction = getCurrentFunctionSymbol(ctx)

	if (parsedID && currentFunction && parsedID !== currentFunction.identifier) {
		ctx.err.report(
			`Expected function ID “${currentFunction.identifier}”, got “${node.functionID!.raw}”`,
			node.functionID!,
		)
	}

	for (const child of node.children ?? []) {
		if (ctx.meta.hasChecker(child.type)) {
			await ctx.meta.getChecker(child.type)(child, ctx)
		}
	}
}
