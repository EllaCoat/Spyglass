import * as core from '@spyglassmc/core'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
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
 * caller の function ID を `ctx.doc.uri` から解決。 URI binder は function file を
 * definition として登録するため、 raw `function` map を走査して同 URI の symbol を探す。
 */
export function getCallerFunctionID(
	ctx: core.CompleterContext,
): string | undefined {
	const functions = ctx.symbols.lookup('function', []).parentMap
	let caller: string | undefined

	for (const symbol of Object.values(functions ?? {})) {
		if (!symbol) {
			continue
		}
		if (!symbol.definition?.some(location => location.uri === ctx.doc.uri)) {
			continue
		}

		// 同一 URI に異なる function ID が付いていたら fail closed (= 候補なし)。
		if (caller !== undefined && caller !== symbol.identifier) {
			return undefined
		}
		caller = symbol.identifier
	}

	return caller
}

/**
 * caller の visibility 判定を満たす IMP-Doc 管理 symbol の identifier を列挙。
 * `getVisibleSymbols()` は Restricted を無条件除外するため、 raw `lookup` の parentMap
 * から取得して自前で filter する。
 */
function getAllowedImpDocIdentifiers(
	category: string,
	ctx: core.CompleterContext,
): string[] {
	const rawMap = ctx.symbols.lookup(category, []).parentMap
	const caller = getCallerFunctionID(ctx)
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
				|| !entries.some(entry => matchesVisibility(entry, caller, 'function'))
			)
		) {
			continue
		}

		ans.push(identifier)
	}

	return ans
}

/**
 * resource_location の label を default namespace / implicit path / lint 設定に沿って
 * 展開する。 core built-in の logic (`packages/core/src/processor/completer/builtin.ts`
 * 相当) を最小 subset で複製。 upstream 変更との drift は Phase 5 で解消候補。
 */
function getResourceLabels(
	identifier: string,
	node: core.DeepReadonly<core.ResourceLocationNode>,
	ctx: core.CompleterContext,
): string[] {
	let id = identifier

	if (node.options.implicitPath) {
		const sep = id.indexOf(core.ResourceLocation.NamespacePathSep)
		const path = id.slice(sep + 1)
		if (!path.startsWith(node.options.implicitPath)) {
			return []
		}
		id = id.slice(0, sep + 1)
			+ path.slice(node.options.implicitPath.length)
	}

	const config = core.LinterConfigValue.destruct(
		ctx.config.lint.idOmitDefaultNamespace,
	)
	const includeCanonical = node.options.requireCanonical
		|| config?.ruleValue !== true
	const includeShort = !node.options.requireCanonical
		&& config?.ruleValue !== false
	const includeEmptyNamespace = !node.options.requireCanonical
		&& node.namespace === ''

	const defaultPrefix = `${core.ResourceLocation.DefaultNamespace}:`
	let labels = id.startsWith(defaultPrefix)
		? [
			...(includeCanonical ? [id] : []),
			...(includeShort ? [id.slice(defaultPrefix.length)] : []),
			...(includeEmptyNamespace
				? [id.slice(core.ResourceLocation.DefaultNamespace.length)]
				: []),
		]
		: [id]

	if (node.options.namespacePathSep === '.') {
		labels = labels.map(label => label.replace(core.ResourceLocation.NamespacePathSep, '.'))
	}

	return labels
}

function completeResourceLocation(
	node: core.DeepReadonly<core.ResourceLocationNode>,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	if (!node.options.category) {
		return []
	}

	// IMP-Doc は `tag/<category>` を stamp しないため tag 参照は候補外。 label に `#`
	// prefix が付かず node range が typed `#` を含む broken insert になるのを避ける。
	if (node.isTag) {
		return []
	}

	return getAllowedImpDocIdentifiers(node.options.category, ctx).flatMap(
		identifier =>
			getResourceLabels(identifier, node, ctx).map(label =>
				core.CompletionItem.create(label, node, {
					kind: core.CompletionKind.Function,
				})
			),
	)
}

function completeSymbol(
	node: core.DeepReadonly<core.SymbolNode>,
	ctx: core.CompleterContext,
): core.CompletionItem[] {
	return getAllowedImpDocIdentifiers(node.options.category, ctx).map(
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
			const additions = getAllowedImpDocIdentifiers('score_holder', ctx).map(
				identifier =>
					core.CompletionItem.create(identifier, scoreRange, {
						kind: core.CompletionKind.Variable,
					}),
			)
			return dedupeCompletionItems([...baseItems, ...additions])
		},
	)
}
