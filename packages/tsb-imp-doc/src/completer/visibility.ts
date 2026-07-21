import * as core from '@spyglassmc/core'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
import { getDocumentResource } from '../util/documentFunction.js'
import { getVisibilityEntries, matchesVisibility } from '../util/withinPattern.js'

/**
 * java-edition の `mcfunction:score_holder` node を production dependency 追加なしに
 * 扱うための最小型。 実装元:
 * `/home/ubuntu/tsb-workspace/dhp-migration/fork/Spyglass/packages/java-edition/src/mcfunction/completer/argument.ts:520`
 */
interface ScoreHolderCompletionNode extends core.AstNode {
	readonly type: 'mcfunction:score_holder'
	readonly fakeName?: core.SymbolNode
	readonly selector?: core.AstNode
}

/**
 * caller の visibility 判定を満たす IMP-Doc 管理 symbol の identifier を列挙。
 * `getVisibleSymbols()` は Restricted を無条件除外するため、 raw `lookup` の parentMap
 * から取得して自前で filter する。 caller は generic caller API
 * (`getDocumentResource`) で解決するので、 JSON / worldgen 文書からの completion でも
 * `@within` の file type 判定が働く。
 */
export function getAllowedImpDocIdentifiers(
	category: string,
	node: core.DeepReadonly<core.AstNode> | undefined,
	ctx: core.CompleterContext,
): string[] {
	const rawMap = ctx.symbols.lookup(category, []).parentMap
	const caller = getDocumentResource(ctx, node as core.AstNode | undefined)
	const ans: string[] = []

	for (const [identifier, symbol] of Object.entries(rawMap ?? {})) {
		if (!symbol || !core.SymbolUtil.isDeclared(symbol)) {
			continue
		}

		const entries = getVisibilityEntries(getImpDocSymbolData(symbol.data))
		if (entries.length === 0) {
			// IMP-Doc 管理外の symbol は base completer に任せる (= 重複追加しない)。
			continue
		}

		// v3 union parity: definition / declaration のどれか 1 entry でも public
		// か caller を許可すれば候補に載せる (any-match)。
		if (
			!entries.some(entry => entry.type === 'public')
			&& (
				caller === undefined
				|| !entries.some(entry => matchesVisibility(entry, caller.resourceID, caller.fileType))
			)
		) {
			continue
		}

		ans.push(identifier)
	}

	return ans
}

function completeResourceLocation(
	node: core.DeepReadonly<core.ResourceLocationNode>,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	if (!node.options.category) {
		return []
	}

	// base completer (`core/processor/completer/builtin.ts#resourceLocation`) と同じ
	// pool 構成 (plain は requireTag で除外、 tag は allowTag で `#` prefix 付与) と
	// 同じ label 正規化 helper を使い、 tag prefix / namespace 規則の drift を防ぐ。
	const labels = [
		...(!node.options.requireTag
			? core.completer.normalizeResourceLocationLabels(
				getAllowedImpDocIdentifiers(node.options.category, node, ctx),
				node,
				ctx,
			)
			: []),
		...(node.options.allowTag
			? core.completer.normalizeResourceLocationLabels(
				getAllowedImpDocIdentifiers(`tag/${node.options.category}`, node, ctx),
				node,
				ctx,
			).map(label => `${core.ResourceLocation.TagPrefix}${label}`)
			: []),
	]

	return labels.map(label =>
		core.CompletionItem.create(label, node, {
			kind: core.CompletionKind.Function,
		})
	)
}

function completeSymbol(
	node: core.DeepReadonly<core.SymbolNode>,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	return getAllowedImpDocIdentifiers(node.options.category, node, ctx).map(
		identifier =>
			core.CompletionItem.create(identifier, node, {
				kind: core.CompletionKind.Variable,
			}),
	)
}

/**
 * `label + range` で重複除去。 base-first で built-in の detail / sortText 等を保持。
 */
export function dedupeCompletionItems(
	items: readonly core.CompletionItem[],
): core.CompletionItem[] {
	const seen = new Set<string>()
	const ans: core.CompletionItem[] = []

	for (const item of items) {
		const key = `${item.label}\0${item.range.start}:${item.range.end}`
		if (!seen.has(key)) {
			seen.add(key)
			ans.push(item)
		}
	}

	return ans
}

/**
 * Language Server 経路 (= je.initialize 後) で呼ぶ。 core built-in の
 * `resource_location` / `symbol` と java-edition の `mcfunction:score_holder` を wrap
 * して IMP-Doc の visibility-aware 候補を追加する。
 */
export function registerVisibilityCompleters(meta: core.MetaRegistry): void {
	if (
		!meta.hasCompleter<core.ResourceLocationNode>('resource_location')
		|| !meta.hasCompleter<core.SymbolNode>('symbol')
		|| !meta.hasCompleter<ScoreHolderCompletionNode>('mcfunction:score_holder')
	) {
		throw new Error(
			'[tsb-imp-doc] Java Edition completers must be registered before '
				+ 'tsb-imp-doc completion wrapping (= run je.initialize first)',
		)
	}

	const baseResource = meta.getCompleter<core.ResourceLocationNode>(
		'resource_location',
	)
	meta.registerCompleter<core.ResourceLocationNode>(
		'resource_location',
		(node, ctx) => {
			const baseItems = baseResource(node, ctx)
			const impDocItems = completeResourceLocation(node, ctx)
			return dedupeCompletionItems([...baseItems, ...impDocItems])
		},
	)

	const baseSymbol = meta.getCompleter<core.SymbolNode>('symbol')
	meta.registerCompleter<core.SymbolNode>(
		'symbol',
		(node, ctx) => {
			const baseItems = baseSymbol(node, ctx)
			const impDocItems = completeSymbol(node, ctx)
			return dedupeCompletionItems([...baseItems, ...impDocItems])
		},
	)

	const baseScoreHolder = meta.getCompleter<ScoreHolderCompletionNode>(
		'mcfunction:score_holder',
	)
	meta.registerCompleter<ScoreHolderCompletionNode>(
		'mcfunction:score_holder',
		(node, ctx) => {
			const baseItems = baseScoreHolder(node, ctx)
			// cursor が selector 引数内 (= `@a[scores={...` 等) の時は IMP-Doc score
			// holder 名を追加しない。 base je completer (`argument.ts:scoreHolder`) は
			// ScoreHolderNode 直下の `node.children[0]` を判定するが、 ここでは「引数内で
			// 候補外」 が目的なので selector の先頭 literal 範囲 (= `@a` の頭記号) で
			// 判定する。
			if (node.selector) {
				const selectorHead = node.selector.children?.[0]
				if (
					!selectorHead
					|| !core.Range.contains(selectorHead, ctx.offset, true)
				) {
					return baseItems
				}
			}
			const scoreRange = node.fakeName ?? node
			const additions = getAllowedImpDocIdentifiers('score_holder', node, ctx)
				.map(identifier =>
					core.CompletionItem.create(identifier, scoreRange, {
						kind: core.CompletionKind.Variable,
					})
				)
			return dedupeCompletionItems([...baseItems, ...additions])
		},
	)
}
