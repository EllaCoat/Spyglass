import * as core from '@spyglassmc/core'
import type {
	ImpDocDeclarationNode,
	ImpDocDeclarationSource,
	ImpDocNode,
} from '../node/ImpDocNode.js'
import { getImpDocSymbolData, ImpDocNode as ImpDocNodeUtil } from '../node/ImpDocNode.js'
import { parseVisibility, stampVisibility } from '../util/withinPattern.js'

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

function ownerForDocument(
	ctx: core.BinderContext,
): string | undefined {
	const functions = ctx.symbols.lookup('function', []).parentMap
	let declaredOwner: string | undefined
	for (const symbol of Object.values(functions ?? {})) {
		if (!symbol) {
			continue
		}
		if (symbol.definition?.some(location => location.uri === ctx.doc.uri)) {
			return symbol.identifier
		}
		if (
			declaredOwner === undefined
			&& symbol.declaration?.some(location => location.uri === ctx.doc.uri)
		) {
			declaredOwner = symbol.identifier
		}
	}
	return declaredOwner
}

function compareSource(
	a: ImpDocDeclarationSource,
	b: ImpDocDeclarationSource,
): number {
	if (a.uri !== b.uri) {
		return a.uri < b.uri ? -1 : 1
	}
	return a.range.start - b.range.start || a.range.end - b.range.end
}

function isFirstReboundDeclaration(
	symbol: core.Symbol,
	candidate: ImpDocDeclarationSource,
): boolean {
	return !symbol.declaration?.some(location =>
		location.uri === candidate.uri
		&& location.range !== undefined
		&& (
			location.range.start < candidate.range.start
			|| (
				location.range.start === candidate.range.start
				&& location.range.end < candidate.range.end
			)
		)
	)
}

export const declaration = core.SyncBinder.create<ImpDocDeclarationNode>(
	(node, ctx) => {
		const doc = enclosingImpDoc(node)
		if (!doc) {
			ctx.err.report('Detached IMP-Doc declaration', node)
			return
		}

		const owner = ownerForDocument(ctx) ?? doc.functionID?.raw
		if (!owner) {
			ctx.err.report(
				'Cannot resolve #declare owner function',
				node.name.range,
			)
			return
		}

		const visibility = parseVisibility(doc.annotations, owner, ctx.err)
			?? { type: 'public' as const }

		doc.visibility = visibility

		const candidate: ImpDocDeclarationSource = {
			uri: ctx.doc.uri,
			range: node.name.range,
			owner,
		}

		const before = ctx.symbols.lookup(
			node.category,
			[node.name.raw],
			node,
		).symbol
		const previous = getImpDocSymbolData(before?.data)?.declaration

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

		// URI/range の辞書順で canonical metadata を決定 (= 重複宣言時の
		// 先頭を canonical とし、 再解析で metadata が非決定的に変わることを防ぐ)。
		if (
			!previous
			|| (
				previous.uri === candidate.uri
				&& isFirstReboundDeclaration(symbol, candidate)
			)
			|| compareSource(candidate, previous) < 0
		) {
			stampVisibility(symbol, visibility, candidate)
			if (core.Range.containsRange(doc.range, node.range)) {
				symbol.desc = ImpDocNodeUtil.getDescription(doc)
			}
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
