import { SymbolUtil } from '@spyglassmc/core'
import type { AstNode, Linter, LinterContext, Logger, Symbol as CoreSymbol } from '@spyglassmc/core'
import type {
	ImpDocDeclarationVisibility,
	ImpDocSymbolData,
	ImpDocVisibility,
} from '../node/ImpDocNode.js'
import { getImpDocSymbolData } from '../node/ImpDocNode.js'
import { getCanonicalDeclarationOwnerUri } from '../util/withinPattern.js'

export function conflictConfigValidator(
	_ruleName: string,
	value: unknown,
	logger: Logger,
): boolean {
	if (typeof value === 'boolean') {
		return value
	}
	logger.error(
		'[Invalid Linter Config] [impDocVisibilityConflict] Expected a boolean value',
	)
	return false
}

interface ConflictCounterpart {
	visibility: ImpDocVisibility
	/** Human-readable location of the counterpart declaration. */
	where: string
}

interface ConflictSource extends ConflictCounterpart {}

function compareDeclarationSource(
	a: ImpDocDeclarationVisibility,
	b: ImpDocDeclarationVisibility,
): number {
	if (a.uri !== b.uri) {
		return a.uri < b.uri ? -1 : 1
	}
	return a.range.start - b.range.start || a.range.end - b.range.end
}

function getSortedDeclarations(
	data: ImpDocSymbolData,
): ImpDocDeclarationVisibility[] {
	return [...data.declarations ?? []].sort(compareDeclarationSource)
}

/**
 * union (OR) 意味論の下で「宣言者の意図が両立しない」 組み合わせのみ矛盾扱いする :
 * - public + restricted の混在 = restricted 側の意図が union で無効化される
 * - 厳格 `@private` 同士で owner が異なる = 排他所有の主張が両立しない
 *
 * `@within` / `@internal` の union (= 許可 caller の追加宣言) は v3 で正当な
 * idiom (caller-local `#declare`) のため矛盾にしない。 同 owner の `@private`
 * 重複も矛盾ではない。 `denied` (= malformed annotation) は binder が error
 * 済みなので二重報告しない。
 */
function getConflictMessage(
	identifier: string,
	own: ImpDocVisibility,
	counterpart: ConflictCounterpart,
): string | undefined {
	const other = counterpart.visibility
	if (own.type === 'denied' || other.type === 'denied') {
		return undefined
	}
	if ((own.type === 'public') !== (other.type === 'public')) {
		return `Visibility of “${identifier}” is contradictory: it is declared ${
			own.type === 'public'
				? 'public here but restricted'
				: 'restricted here but public'
		} in ${counterpart.where}, so the union makes it public everywhere`
	}
	if (own.type === 'private' && other.type === 'private' && own.owner !== other.owner) {
		return `Visibility of “${identifier}” is contradictory: it is private to “${own.owner}” here and private to “${other.owner}” in ${counterpart.where}, so the union allows both owners`
	}
	return undefined
}

function getConflictMessages(
	identifier: string,
	data: ImpDocSymbolData,
	declarations: readonly ImpDocDeclarationVisibility[],
): string[] {
	const sources: ConflictSource[] = [
		...(data.visibility
			? [{ visibility: data.visibility, where: 'the function header' }]
			: []),
		...declarations.map(entry => ({
			visibility: entry.visibility,
			where: `“${entry.uri}”`,
		})),
	]
	const messages: string[] = []
	for (let index = 0; index < sources.length; index += 1) {
		const own = sources[index]!
		for (const counterpart of sources.slice(index + 1)) {
			const message = getConflictMessage(identifier, own.visibility, counterpart)
			if (message) {
				messages.push(message)
			}
		}
	}
	return messages
}

function getConflictOwnerRange(
	symbol: CoreSymbol,
	declarations: readonly ImpDocDeclarationVisibility[],
	ownerUri: string,
) {
	const definition = symbol.definition?.find(location => location.uri === ownerUri)
	if (definition?.range) {
		return definition.range
	}
	return declarations.find(entry => entry.uri === ownerUri)?.range
		?? { start: 0, end: 0 }
}

function hasLocationAtUri(symbol: CoreSymbol, uri: string): boolean {
	return (symbol.definition?.some(location => location.uri === uri) ?? false)
		|| (symbol.declaration?.some(location => location.uri === uri) ?? false)
}

function getSymbolsForDocument(ctx: LinterContext): CoreSymbol[] {
	const candidates = ctx.symbols.getSymbolCandidatesAtUri(ctx.doc.uri)
	if (candidates.length > 0) {
		// The reverse URI cache returns a stale superset (entries are never
		// removed with their locations, see `getSymbolCandidatesAtUri`), so
		// re-verify that each candidate still has a location in this document.
		// Otherwise documents with removed declarations keep queueing unrelated
		// conflict owners for implicit lint passes.
		return candidates.filter(symbol => hasLocationAtUri(symbol, ctx.doc.uri))
	}

	// Direct/unit contexts do not always call SymbolUtil.buildCache(). Keep the
	// same result shape by falling back to a complete location scan in that case.
	const symbols: CoreSymbol[] = []
	SymbolUtil.forEachSymbol(ctx.symbols.global, (symbol) => {
		if (hasLocationAtUri(symbol, ctx.doc.uri)) {
			symbols.push(symbol)
		}
	})
	return symbols
}

/**
 * 同一 symbol の矛盾 pair は canonical owner document の一箇所にだけ配置する。
 * function は definition/header document、 それ以外は `(uri, range)` 昇順先頭の
 * declaration document を owner とするため、両側 declaration への重複診断や
 * editor 上の片側 stale を作らない。
 */
export const visibilityConflict: Linter<AstNode> = (_node, ctx: LinterContext) => {
	for (const symbol of getSymbolsForDocument(ctx)) {
		const data = getImpDocSymbolData(symbol.data)
		if (!data) {
			continue
		}
		const declarations = getSortedDeclarations(data)
		const ownerUri = getCanonicalDeclarationOwnerUri(symbol, declarations)
		const messages = getConflictMessages(symbol.identifier, data, declarations)
		if (ownerUri !== ctx.doc.uri) {
			// The owner can be unopened in an LSP session. Defer its lint until
			// this document's bind/check has settled so the diagnostic remains
			// canonical while still being published immediately.
			if (ownerUri && messages.length > 0) {
				ctx.queueLint?.(ownerUri)
			}
			continue
		}

		const range = getConflictOwnerRange(symbol, declarations, ownerUri)
		for (const message of messages) {
			ctx.err.lint(message, range)
		}
	}
}
