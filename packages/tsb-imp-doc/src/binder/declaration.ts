import * as core from '@spyglassmc/core'
import { getCanonicalSymbolCategory } from '../legacy/categories.js'
import { canonicalizeLegacyDeclarationSymbolName } from '../legacy/syntax.js'
import type {
	ImpDocDeclarationNode,
	ImpDocDeclarationSource,
	ImpDocNode,
} from '../node/ImpDocNode.js'
import { getImpDocSymbolData, ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import { getDocumentFunction } from '../util/documentFunction.js'
import {
	fallbackVisibility,
	parseVisibility,
	restoreCanonicalDeclarationDesc,
	stampVisibility,
	trackDeclarationVisibility,
} from '../util/withinPattern.js'
import { resolvePendingEntityReferences } from './entity.js'

function enclosingImpDoc(node: core.AstNode): ImpDocNode | undefined {
	let parent = node.parent
	while (parent) {
		if (ImpDocNodeUtil.is(parent)) {
			return parent
		}
		parent = parent.parent
	}
	return undefined
}

const ownerCache = new WeakMap<core.BinderContext, { value: string | undefined }>()

function ownerForDocument(
	ctx: core.BinderContext,
	node: core.AstNode,
): string | undefined {
	const cached = ownerCache.get(ctx)
	if (cached) {
		return cached.value
	}
	const owner = getDocumentFunction(ctx, node)?.identifier
	ownerCache.set(ctx, { value: owner })
	return owner
}

export const declaration = core.SyncBinder.create<ImpDocDeclarationNode>(
	(node, ctx) => {
		const doc = enclosingImpDoc(node)
		if (!doc) {
			ctx.err.report('Detached IMP-Doc declaration', node)
			return
		}

		const owner = ownerForDocument(ctx, node)
			?? (doc.functionID?.raw
				? core.ResourceLocation.lengthen(doc.functionID.raw)
				: undefined)
		if (!owner) {
			ctx.err.report(
				'Cannot resolve #declare owner function',
				node.name.range,
			)
			return
		}

		const visibility = parseVisibility(doc.annotations, owner, ctx.err)
			?? fallbackVisibility(doc.annotations, owner, ctx.err)

		doc.visibility = visibility

		const candidate: ImpDocDeclarationSource = {
			uri: ctx.doc.uri,
			range: node.name.range,
			owner,
			description: ImpDocNodeUtil.getDescription(doc),
		}

		// `sequence` などの mapped category は canonical (v4) symbol table に集約する。
		const category = getCanonicalSymbolCategory(node.category)
		const name = canonicalizeLegacyDeclarationSymbolName(
			node.category,
			node.name.raw,
		) ?? node.name.raw
		ctx.symbols.query(
			ctx.doc,
			category,
			name,
		).enter({
			usage: {
				type: 'declaration',
				range: node.name.range,
			},
		})

		// Restricted query() は symbol を隠すため、 enter 後は raw lookup で取得。
		const symbol = ctx.symbols.lookup(
			category,
			[name],
			node,
		).symbol
		if (!symbol) {
			return
		}

		node.symbol = symbol

		// URI 単位の stale purge は Project の binder/release lifecycle hook が
		// declaration binder より先に済ませる。ここでは今回 bind した位置を
		// v3 union entry として記録するだけにする。
		stampVisibility(symbol, visibility, candidate)
		trackDeclarationVisibility(ctx.symbols, symbol, candidate.uri)
		if (category === 'entity') {
			resolvePendingEntityReferences(ctx, name)
		}

		// desc は attached-only symbol と同じ canonical helper で決める。
		// function header が生きている間 (`headerUri` あり) は header 側 desc が
		// 優先し、それ以外は (uri, range) 辞書順先頭の declaration entry が担う。
		const data = getImpDocSymbolData(symbol.data)
		if (data) {
			restoreCanonicalDeclarationDesc(symbol, data)
		}

		// core の getDeclaredLocation() が同じ canonical を返すよう整列。
		symbol.declaration?.sort((a, b) => {
			if (a.uri !== b.uri) {
				return a.uri < b.uri ? -1 : 1
			}
			return (a.range?.start ?? 0) - (b.range?.start ?? 0)
				|| (a.range?.end ?? 0) - (b.range?.end ?? 0)
		})
	},
)
