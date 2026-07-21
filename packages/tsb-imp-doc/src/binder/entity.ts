import * as core from '@spyglassmc/core'

/** java-edition の `EntityNode` を production dependency 追加なしに扱う最小型。 */
interface EntityBinderNode extends core.AstNode {
	readonly type: 'mcfunction:entity'
	readonly playerName?: core.StringNode
}

interface PendingEntityReference {
	readonly doc: core.BinderContext['doc']
	readonly name: string
	readonly node: core.StringNode
}

const pendingReferences = new WeakMap<core.SymbolUtil, PendingEntityReference[]>()

function enterReference(
	symbols: core.SymbolUtil,
	doc: core.BinderContext['doc'],
	name: string,
	node: core.StringNode,
): void {
	symbols.query(doc, 'entity', name).enter({
		usage: { type: 'reference', node },
	})
}

function deferReference(
	symbols: core.SymbolUtil,
	doc: core.BinderContext['doc'],
	name: string,
	node: core.StringNode,
): void {
	const entries = pendingReferences.get(symbols) ?? []
	if (
		!entries.some(entry =>
			entry.doc.uri === doc.uri
			&& entry.node.range.start === node.range.start
			&& entry.node.range.end === node.range.end
		)
	) {
		entries.push({ doc, name, node })
		pendingReferences.set(symbols, entries)
	}
}

/** Drop deferred ASTs before a document is rebound or removed. */
export function clearPendingEntityReferencesForUri(
	symbols: core.SymbolUtil,
	uri: string,
): void {
	const entries = pendingReferences.get(symbols)
	if (!entries) {
		return
	}
	const remaining = entries.filter(entry => entry.doc.uri !== uri)
	if (remaining.length > 0) {
		pendingReferences.set(symbols, remaining)
	} else {
		pendingReferences.delete(symbols)
	}
}

/** Resolve consumer-first references immediately after an entity declaration is registered. */
export function resolvePendingEntityReferences(
	ctx: core.BinderContext,
	name: string,
): void {
	const declared = ctx.symbols.lookup('entity', [name]).symbol
	if (!declared || !core.SymbolUtil.isDeclared(declared)) {
		return
	}
	const entries = pendingReferences.get(ctx.symbols)
	if (!entries) {
		return
	}
	const matching = entries.filter(entry => entry.name === name)
	const remaining = entries.filter(entry => entry.name !== name)
	if (remaining.length > 0) {
		pendingReferences.set(ctx.symbols, remaining)
	} else {
		pendingReferences.delete(ctx.symbols)
	}
	for (const entry of matching) {
		enterReference(ctx.symbols, entry.doc, entry.name, entry.node)
	}
}

/**
 * `mcfunction:entity` の usage-site binder (v3 `EntityArgumentParser.ts:133-142`
 * parity、 spike 1 判断 B)。 plain name が `#declare entity` 済みなら soft
 * reference を記録し、 declaration が後なら一時保留する。 declaration が最後まで
 * 無い名前は error にも symbol にもしないため、任意の player 名で plugin-local
 * `entity` table を汚さない。 reference が付くと core 共通 consumer (hover /
 * definition / references) が `node.symbol` 経由で効く。
 */
export const bindEntity = core.AsyncBinder.create<EntityBinderNode>(
	async (node, ctx) => {
		// この binder 登録で core fallback の descent が `mcfunction:entity` で
		// 停止するため、 selector 配下の `symbol` / `resource_location` binder を
		// 明示 dispatch で降ろす (binder/impDoc.ts の child dispatch と同型)。
		for (const child of node.children ?? []) {
			const childBinder = ctx.meta.getBinder(child.type)
			const result = childBinder(child, ctx)
			if (result instanceof Promise) {
				await result
			}
		}

		const playerName = node.playerName
		const name = playerName?.value
		if (!name) {
			return
		}
		const declared = ctx.symbols.lookup('entity', [name]).symbol
		if (!declared || !core.SymbolUtil.isDeclared(declared)) {
			deferReference(ctx.symbols, ctx.doc, name, playerName)
			return
		}
		enterReference(ctx.symbols, ctx.doc, name, playerName)
	},
)
