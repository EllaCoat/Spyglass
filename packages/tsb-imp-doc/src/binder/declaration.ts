import * as core from '@spyglassmc/core'
import type {
	ImpDocDeclarationNode,
	ImpDocDeclarationSource,
	ImpDocNode,
} from '../node/ImpDocNode.js'
import { getImpDocSymbolData, ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import {
	fallbackVisibility,
	parseVisibility,
	stampVisibility,
	trackDeclarationVisibility,
} from '../util/withinPattern.js'

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
): string | undefined {
	const cached = ownerCache.get(ctx)
	if (cached) {
		return cached.value
	}
	const functions = ctx.symbols.lookup('function', []).parentMap
	let declaredOwner: string | undefined
	for (const symbol of Object.values(functions ?? {})) {
		if (!symbol) {
			continue
		}
		if (symbol.definition?.some(location => location.uri === ctx.doc.uri)) {
			ownerCache.set(ctx, { value: symbol.identifier })
			return symbol.identifier
		}
		if (
			declaredOwner === undefined
			&& symbol.declaration?.some(location => location.uri === ctx.doc.uri)
		) {
			declaredOwner = symbol.identifier
		}
	}
	ownerCache.set(ctx, { value: declaredOwner })
	return declaredOwner
}

export const declaration = core.SyncBinder.create<ImpDocDeclarationNode>(
	(node, ctx) => {
		const doc = enclosingImpDoc(node)
		if (!doc) {
			ctx.err.report('Detached IMP-Doc declaration', node)
			return
		}

		const owner = ownerForDocument(ctx)
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

		ctx.symbols.query(
			ctx.doc,
			node.category,
			node.name.raw,
		).enter({
			usage: {
				type: 'declaration',
				range: node.name.range,
			},
		})

		// Restricted query() は symbol を隠すため、 enter 後は raw lookup で取得。
		const symbol = ctx.symbols.lookup(
			node.category,
			[node.name.raw],
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

		// desc は (uri, range) 辞書順先頭の declaration entry が担う (= 再解析で
		// 非決定的に変わることを防ぐ、 canonical 1 本時代からの determinism 維持)。
		const first = getImpDocSymbolData(symbol.data)?.declarations?.[0]
		if (
			first
			&& first.uri === candidate.uri
			&& first.range.start === candidate.range.start
			&& first.range.end === candidate.range.end
		) {
			symbol.desc = candidate.description
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
