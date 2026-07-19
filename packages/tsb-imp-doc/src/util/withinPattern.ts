// core の Symbol 型は global Symbol constructor (unique symbol 宣言で使用) と
// 衝突するため alias で import する。
import { StateProxy, SymbolUtil } from '@spyglassmc/core'
import type { ErrorReporter, Symbol as CoreSymbol } from '@spyglassmc/core'
import { isLegacyWithinTarget } from '../legacy/categories.js'
import type {
	ImpDocAnnotation,
	ImpDocDeclarationSource,
	ImpDocDeclarationVisibility,
	ImpDocSymbolData,
	ImpDocValue,
	ImpDocVisibility,
	WithinPattern,
	WithinTargetType,
} from '../node/ImpDocNode.js'
import { getImpDocSymbolData, ImpDocNode } from '../node/ImpDocNode.js'

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: {}
}

/**
 * `symbol.data` is outside core's SymbolLocation lifecycle, so retain a
 * per-SymbolUtil reverse index for declaration visibility entries. The first
 * access reconstructs it from a loaded symbol cache; later declaration binds
 * update it incrementally.
 */
type DeclarationVisibilityIndex = Map<string, Set<CoreSymbol>>
const declarationVisibilityIndexes = new WeakMap<SymbolUtil, DeclarationVisibilityIndex>()

function addToDeclarationVisibilityIndex(
	index: DeclarationVisibilityIndex,
	symbol: CoreSymbol,
	uri: string,
): void {
	let symbols = index.get(uri)
	if (!symbols) {
		symbols = new Set()
		index.set(uri, symbols)
	}
	symbols.add(symbol)
}

function getDeclarationVisibilityIndex(symbols: SymbolUtil): DeclarationVisibilityIndex {
	let index = declarationVisibilityIndexes.get(symbols)
	if (index) {
		return index
	}

	index = new Map()
	SymbolUtil.forEachSymbol(symbols.global, (symbol) => {
		for (const entry of getImpDocSymbolData(symbol.data)?.declarations ?? []) {
			addToDeclarationVisibilityIndex(index!, symbol, entry.uri)
		}
	})
	declarationVisibilityIndexes.set(symbols, index)
	return index
}

const RegexSpecials = new Set([
	'\\',
	'^',
	'$',
	'.',
	'+',
	'?',
	'(',
	')',
	'[',
	']',
	'{',
	'}',
	'|',
])

/**
 * `matchesVisibility()` が compile した RegExp の per-pattern cache (Option A)。 key は
 * `WithinPattern` の object identity (寿命は WeakMap 経由で GC 任せ)。 pattern
 * 自体は serialize されるため RegExp を埋め込まず、 cache 側に分離して保持する。
 * Option B (`preparedVisibilityCache`) の fallback path でも使用する。
 */
type CompiledEntry = { source: string; regexp: RegExp }
const compiledPatternCache: WeakMap<WithinPattern, CompiledEntry> = new WeakMap()

function getCompiledPatternRegExp(pattern: WithinPattern): RegExp {
	// linter は StateProxy 経由で pattern を渡すため handler ごとに identity が異なる。
	// origin object を key に正規化しないと cache が hit しない (Terra 2 巡目 MUST)。
	const key = StateProxy.dereference(pattern)
	const entry = compiledPatternCache.get(key)
	// source 一致確認は defense in depth (同一 identity のまま regex が書き換わる
	// ケースは想定外だが、 食い違ったら新 entry で上書きする)。
	if (entry && entry.source === key.regex) {
		return entry.regexp
	}
	// flag は付けない (g / y は lastIndex が呼び出し間で残り判定が非決定的になる)。
	const regexp = new RegExp(key.regex)
	compiledPatternCache.set(key, { source: key.regex, regexp })
	return regexp
}

/**
 * visibility 単位の caller type 別 unified RegExp cache (Option B)。 有効 patterns を
 * `(?:...)|(?:...)` に畳んで 1 回の `test()` で判定する。 各 slot の意味 :
 * - `RegExp` : compile 済 unified regex
 * - `undefined` : 該当 caller type 向けの有効 patterns がゼロ (owner short-circuit 後は常に false)
 * - `PreparedFallback` : canonical 外 / 巨大 source / compile failure。 per-pattern
 *   cache (Option A) の順序付き `.some()` 評価に降ろす
 */
const PreparedFallback: unique symbol = Symbol('PreparedFallback')
type PreparedRegExp = RegExp | undefined | typeof PreparedFallback
type CallerTypeCache = Map<string, PreparedRegExp>
const preparedVisibilityCache: WeakMap<
	Extract<ImpDocVisibility, { type: 'within' }>,
	CallerTypeCache
> = new WeakMap()

type PreparedInternal = { owner: string; regexps: readonly RegExp[] }
const preparedInternalCache: WeakMap<
	Extract<ImpDocVisibility, { type: 'internal' }>,
	PreparedInternal
> = new WeakMap()

// fallback 閾値。 実 workload の pattern source は 100 bytes 以下なので 10x 余裕の
// 安全側 (V8 Irregexp の compile time が悪化しない範囲)。
const MaxPatternSourceLength = 1024
const MaxUnifiedSourceLength = 16384

/** caller type 向けの unified regex を組む。 fallback 条件は `PreparedFallback` の doc 参照。 */
function buildPreparedRegExp(
	patterns: readonly WithinPattern[],
	callerType: WithinTargetType,
): PreparedRegExp {
	// filter/canonical/累積を単一 loop に統合 (巨大入力を早期停止)。 順序は最軽 (targetType
	// 一致 → 単一 source 長 → canonical 再生成 → 累積長) で fallback 判定を最短化。
	let unifiedLength = 0
	const sources: string[] = []
	for (const pattern of patterns) {
		if (pattern.targetType !== '*' && pattern.targetType !== callerType) {
			continue
		}
		if (pattern.regex.length > MaxPatternSourceLength) {
			return PreparedFallback
		}
		// canonical 外 (raw から regex を再導出できない) は Option A の semantics を保護
		// するため per-pattern 評価に降ろす。
		if (pattern.regex !== legacyGlobToRegex(pattern.raw)) {
			return PreparedFallback
		}
		const source = `(?:${pattern.regex})`
		// separator `|` は 2 個目以降で 1 char 加算。
		unifiedLength += source.length + (sources.length > 0 ? 1 : 0)
		if (unifiedLength > MaxUnifiedSourceLength) {
			return PreparedFallback
		}
		sources.push(source)
	}
	// 空 alternation `(?:)` は全 match (= default-allow bug) になるため regex を作らない。
	if (sources.length === 0) {
		return undefined
	}
	try {
		// flag は付けない (g / y は lastIndex が呼び出し間で残り判定が非決定的になる)。
		return new RegExp(sources.join('|'))
	} catch {
		return PreparedFallback
	}
}

/**
 * Legacy IMP-Doc の path pattern を anchored regex source に変換する。
 * literal regex 文字を先に escape し、 wildcard 自体は v3 と同じ4段階
 * (`?` -> double-star + slash -> `**` -> `*`) で前段の結果へ逐次適用する。
 * separator は resource ID の namespace/path を区切る `:` と `/` の双方。
 */
export function legacyGlobToRegex(pattern: string): string {
	let escaped = ''
	for (const char of pattern) {
		if (char === '?' || char === '*') {
			escaped += char
		} else {
			escaped += RegexSpecials.has(char) ? `\\${char}` : char
		}
	}

	const translated = escaped
		.replace(/\?/g, '[^:/]')
		.replace(/\*\*\//g, '.{0,}')
		.replace(/\*\*/g, '.{0,}')
		.replace(/\*/g, '[^:/]{0,}')
	return `^${translated}$`
}

function parseWithin(
	values: readonly ImpDocValue[],
	err?: ErrorReporter,
): WithinPattern | undefined {
	const [, first, second, ...extra] = values
	if (!first) {
		err?.report('@within requires a path pattern', values[0])
		return undefined
	}
	if (extra.length) {
		err?.report('@within accepts one path pattern per line', extra[0])
		return undefined
	}

	// Legacy: `@within <pattern>` は target type `*`、 `@within function <pattern>` は `function`。
	const targetType: string = second ? first.raw : '*'
	const raw = second?.raw ?? first.raw

	if (!isLegacyWithinTarget(targetType)) {
		err?.report(
			`Unsupported @within target type "${targetType}"`,
			first,
		)
		return undefined
	}

	return {
		raw,
		targetType,
		regex: legacyGlobToRegex(raw),
	}
}

const DefaultNamespace = 'minecraft'
const DefaultNamespacePrefix = `${DefaultNamespace}:`
const VisibilityAnnotationNames: ReadonlySet<string> = new Set([
	'@within',
	'@internal',
	'@private',
	'@public',
	'@api',
])

function getNamespace(id: string): string {
	const separator = id.indexOf(':')
	return separator < 0 ? DefaultNamespace : id.slice(0, separator)
}

function getInternalPatternRaws(owner: string): string[] {
	const namespace = getNamespace(owner)
	return namespace === DefaultNamespace
		? [`${namespace}:**`]
		: [`${namespace}:**`, `${DefaultNamespace}:**`]
}

function getInternalWithinPatterns(owner: string): WithinPattern[] {
	return getInternalPatternRaws(owner).map(raw => ({
		raw,
		targetType: '*',
		regex: legacyGlobToRegex(raw),
	}))
}

function findVisibilityAnnotation(
	annotations: readonly ImpDocAnnotation[],
): ImpDocValue | undefined {
	return ImpDocNode.flattenAnnotations(annotations)
		.find(values => VisibilityAnnotationNames.has(values[0]?.raw ?? ''))?.[0]
}

export function hasVisibilityAnnotation(
	annotations: readonly ImpDocAnnotation[],
): boolean {
	return findVisibilityAnnotation(annotations) !== undefined
}

/** Apply the hybrid fail-closed default after `parseVisibility()` returns undefined. */
export function fallbackVisibility(
	annotations: readonly ImpDocAnnotation[],
	owner: string,
	err?: ErrorReporter,
): ImpDocVisibility {
	const annotation = findVisibilityAnnotation(annotations)
	if (!annotation) {
		return { type: 'public' }
	}

	err?.report(
		'IMP-Doc visibility annotation is malformed; falling back to deny state',
		annotation,
	)
	return { type: 'denied', owner }
}

/**
 * annotation 群から visibility を解析。 `@public` (と Legacy 別名 `@api`) が含まれれば
 * unrestricted。 `@private` / `@internal` / `@within` は Legacy 同様 OR で合成する。
 */
export function parseVisibility(
	annotations: readonly ImpDocAnnotation[],
	owner: string | undefined,
	err?: ErrorReporter,
): ImpDocVisibility | undefined {
	let isPublic = false
	let isPrivate = false
	let isInternal = false
	let malformedVisibilityAnnotation: ImpDocValue | undefined
	const patterns: WithinPattern[] = []

	for (const values of ImpDocNode.flattenAnnotations(annotations)) {
		switch (values[0]?.raw) {
			case '@public':
			case '@api':
				isPublic = true
				break
			case '@private':
				isPrivate = true
				break
			case '@internal':
				isInternal = true
				break
			case '@within': {
				const pattern = parseWithin(values, err)
				if (pattern) {
					patterns.push(pattern)
				} else {
					malformedVisibilityAnnotation ??= values[0]
				}
				break
			}
		}
	}

	// Fork hybrid: 正常 annotation では Legacy の public 優先を維持する一方、
	// malformed @within は annotation 群の他要素に隠させず fail closed にする。
	if (malformedVisibilityAnnotation) {
		if (!owner) {
			err?.report(
				'Cannot resolve the owner function for restricted IMP-Doc visibility',
				malformedVisibilityAnnotation,
			)
			return undefined
		}
		err?.report(
			'IMP-Doc visibility annotation is malformed; falling back to deny state',
			malformedVisibilityAnnotation,
		)
		return { type: 'denied', owner }
	}
	if (isPublic) {
		return { type: 'public' }
	}
	if (!isPrivate && !isInternal && patterns.length === 0) {
		return undefined
	}
	if (!owner) {
		if (annotations[0]) {
			err?.report(
				'Cannot resolve the owner function for restricted IMP-Doc visibility',
				annotations[0],
			)
		}
		return undefined
	}
	if (patterns.length) {
		return {
			type: 'within',
			owner,
			includeOwner: isPrivate,
			patterns: isInternal
				? [...getInternalWithinPatterns(owner), ...patterns]
				: patterns,
		}
	}
	if (isInternal) {
		return { type: 'internal', owner }
	}
	return { type: 'private', owner }
}

export function toShortestString(id: string): string {
	return id.startsWith(DefaultNamespacePrefix)
		? id.slice(DefaultNamespacePrefix.length)
		: id
}

function testCallerForms(regexp: RegExp, caller: string): boolean {
	const shortest = toShortestString(caller)
	return regexp.test(caller) || (shortest !== caller && regexp.test(shortest))
}

function getPreparedInternalRegExps(
	visibility: Extract<ImpDocVisibility, { type: 'internal' }>,
): readonly RegExp[] {
	const key = StateProxy.dereference(visibility)
	const cached = preparedInternalCache.get(key)
	if (cached?.owner === key.owner) {
		return cached.regexps
	}
	const regexps = getInternalPatternRaws(key.owner)
		.map(raw => new RegExp(legacyGlobToRegex(raw)))
	preparedInternalCache.set(key, { owner: key.owner, regexps })
	return regexps
}

/**
 * caller (= function identifier) が visibility の許可条件を満たすか判定。
 * public / undefined は defensive に許可、 private / denied は owner exact、 internal
 * は namespace patterns、 within は明示 `@private` 時のみ owner、それ以外は patterns。
 * targetType が `*` なら caller の kind を問わず match。
 * within の patterns は `preparedVisibilityCache` (Option B) の unified regex で 1 回の
 * `test()` に畳む。 fallback 発火時は `compiledPatternCache` (Option A) の per-pattern
 * 評価に降ろす。
 */
export function matchesVisibility(
	visibility: ImpDocVisibility | undefined,
	caller: string,
	callerType: WithinTargetType = 'function',
): boolean {
	switch (visibility?.type) {
		case undefined:
		case 'public':
			return true
		case 'private':
		case 'denied':
			return caller === visibility.owner
		case 'internal':
			return getPreparedInternalRegExps(visibility)
				.some(regexp => testCallerForms(regexp, caller))
		case 'within': {
			if (visibility.includeOwner && caller === visibility.owner) {
				return true
			}
			// linter は StateProxy 経由で visibility を渡すため handler ごとに identity が異なる。
			// origin object を key に正規化しないと cache が hit しない (Terra 2 巡目 MUST)。
			const key = StateProxy.dereference(visibility)
			let callerTypeCache = preparedVisibilityCache.get(key)
			if (!callerTypeCache) {
				callerTypeCache = new Map()
				preparedVisibilityCache.set(key, callerTypeCache)
			}
			let compiled: PreparedRegExp
			if (callerTypeCache.has(callerType)) {
				compiled = callerTypeCache.get(callerType)
			} else {
				compiled = buildPreparedRegExp(key.patterns, callerType)
				callerTypeCache.set(callerType, compiled)
			}
			if (compiled === undefined) {
				return false
			}
			if (compiled === PreparedFallback) {
				// fallback path も origin patterns を回す (per-pattern cache も identity dependent)。
				return key.patterns.some(pattern =>
					(pattern.targetType === '*' || pattern.targetType === callerType)
					&& testCallerForms(getCompiledPatternRegExp(pattern), caller)
				)
			}
			return testCallerForms(compiled, caller)
		}
	}
}

/**
 * core の Restricted 表現用に visibilityRestriction (= 正規表現列) を生成。
 * 現 core は Restricted を caller-aware に評価しないが (`SymbolUtil.ts:633`)、
 * 将来 upstream Approach B が入った時の互換のために保持。
 */
export function visibilityRestrictions(
	visibility: ImpDocVisibility,
): string[] | undefined {
	switch (visibility.type) {
		case 'public':
			return undefined
		case 'private':
		case 'denied':
			return [legacyGlobToRegex(visibility.owner)]
		case 'internal':
			return getInternalPatternRaws(visibility.owner).map(legacyGlobToRegex)
		case 'within':
			return [
				...(visibility.includeOwner
					? [legacyGlobToRegex(visibility.owner)]
					: []),
				...visibility.patterns
					.filter(p => p.targetType === '*' || p.targetType === 'function')
					.map(p => p.regex),
			]
	}
}

export function compareDeclarationSource(
	a: ImpDocDeclarationSource,
	b: ImpDocDeclarationSource,
): number {
	if (a.uri !== b.uri) {
		return a.uri < b.uri ? -1 : 1
	}
	return a.range.start - b.range.start || a.range.end - b.range.end
}

/**
 * v3 union parity: 同一 symbol の visibility は「definition (= function header)
 * 1 本 + declaration (= #declare) 位置ごとの list」 を全て列挙する。 参照可否は
 * この entry 群の OR で判定する (legacy-v3 `ClientCache.getCacheForID` の
 * any-position 残存と同挙動)。
 */
export function getVisibilityEntries(
	data: ImpDocSymbolData | undefined,
): ImpDocVisibility[] {
	return [
		...(data?.visibility ? [data.visibility] : []),
		...(data?.declarations ?? []).map(entry => entry.visibility),
	]
}

/** caller が definition / declaration いずれかの visibility を満たすか (any-match)。 */
export function matchesAnyVisibility(
	data: ImpDocSymbolData | undefined,
	caller: string,
	callerType: WithinTargetType = 'function',
): boolean {
	const entries = getVisibilityEntries(data)
	return entries.length === 0
		|| entries.some(entry => matchesVisibility(entry, caller, callerType))
}

/**
 * definition + declaration 全 entry から core 側 aggregate (`symbol.visibility` /
 * `visibilityRestriction` / `privateOwner` 互換 field) を再計算する。 1 entry でも
 * public なら OR 意味論で全体 public、 全 entry restricted なら restriction を
 * 連結する (= core 側 Restricted 評価も正規表現列の OR)。
 */
function refreshAggregateVisibility(
	symbol: CoreSymbol,
	impDoc: ImpDocSymbolData,
): void {
	const entries = getVisibilityEntries(impDoc)
	const restricted = entries.filter(
		(entry): entry is Exclude<ImpDocVisibility, { type: 'public' }> => entry.type !== 'public',
	)
	// SymbolVisibility.Public = 2、 Restricted = 3 (const enum、 strip-types loader
	// では inline されないため数値を直接使用)。
	if (entries.length === 0 || restricted.length < entries.length) {
		delete impDoc.privateOwner
		symbol.visibility = 2
		symbol.visibilityRestriction = undefined
		return
	}
	// entries 順 (= definition 優先、 次いで (uri, range) 昇順) の先頭 owner を
	// 互換 shortcut に反映する。
	impDoc.privateOwner = restricted[0]!.owner
	symbol.visibility = 3
	symbol.visibilityRestriction = [
		...new Set(restricted.flatMap(entry => visibilityRestrictions(entry) ?? [])),
	]
}

/**
 * symbol.data.impDoc に visibility metadata を stamp する。 declaration source を
 * 渡された場合は declaration entry list へ upsert (同一 uri/range を置換) し、
 * source 無し (= function header) は definition-side visibility を上書きする。
 * aggregate (`symbol.visibility` 等) は全 entry の union から再計算する。
 */
export function stampVisibility(
	symbol: CoreSymbol,
	visibility: ImpDocVisibility,
	declaration?: ImpDocDeclarationSource,
): void {
	const root = asRecord(symbol.data)
	const previous = getImpDocSymbolData(symbol.data)
	const impDoc: ImpDocSymbolData = { ...previous }

	if (declaration) {
		const entry: ImpDocDeclarationVisibility = { ...declaration, visibility }
		impDoc.declarations = [
			...(previous?.declarations ?? []).filter(existing =>
				existing.uri !== declaration.uri
				|| existing.range.start !== declaration.range.start
				|| existing.range.end !== declaration.range.end
			),
			entry,
		].sort(compareDeclarationSource)
	} else {
		impDoc.visibility = visibility
	}

	refreshAggregateVisibility(symbol, impDoc)
	symbol.data = { ...root, impDoc }
}

/**
 * 指定 URI が contribute した declaration visibility entry を全て除去する。
 * 再 bind 時、 その URI の最初の declaration が stamp される前に呼び、 編集で
 * 範囲が変わった / 消えた stale entry を掃除する (core の `clear()` が消すのは
 * symbol location のみで `symbol.data` は残るため)。
 */
export function clearDeclarationVisibilities(
	symbol: CoreSymbol,
	uri: string,
): void {
	const root = asRecord(symbol.data)
	const previous = getImpDocSymbolData(symbol.data)
	if (!previous?.declarations?.some(entry => entry.uri === uri)) {
		return
	}

	const impDoc: ImpDocSymbolData = { ...previous }
	const remaining = previous.declarations.filter(entry => entry.uri !== uri)
	if (remaining.length) {
		impDoc.declarations = remaining
	} else {
		delete impDoc.declarations
	}
	// derived shortcut は一旦落とす (restricted entry が残れば refresh が再設定)。
	delete impDoc.privateOwner

	if (Object.keys(impDoc).length === 0) {
		delete root['impDoc']
		symbol.data = root
		// SymbolVisibility.Public = 2 (const enum; use the runtime numeric value).
		symbol.visibility = 2
		delete symbol.visibilityRestriction
		return
	}

	refreshAggregateVisibility(symbol, impDoc)
	symbol.data = { ...root, impDoc }
}

/**
 * Clear all declaration visibility metadata contributed by one document. Core
 * clears SymbolLocations before a rebind or a file removal, but the IMP-Doc
 * payload is stored in `symbol.data` and therefore needs this matching URI
 * lifecycle step. The index is rebuilt from warm-cache data on first use.
 */
export function clearDeclarationVisibilitiesForUri(
	symbols: SymbolUtil,
	uri: string,
): void {
	const index = getDeclarationVisibilityIndex(symbols)
	const affected = index.get(uri)
	if (!affected) {
		return
	}

	// Drop the URI first: current bind will repopulate it through
	// `trackDeclarationVisibility`, while a fully removed URI stays absent.
	index.delete(uri)
	for (const symbol of affected) {
		clearDeclarationVisibilities(symbol, uri)
	}
}

/** Record a freshly bound `#declare` entry in the URI purge index. */
export function trackDeclarationVisibility(
	symbols: SymbolUtil,
	symbol: CoreSymbol,
	uri: string,
): void {
	addToDeclarationVisibilityIndex(getDeclarationVisibilityIndex(symbols), symbol, uri)
}

/**
 * Remove visibility metadata previously contributed by an IMP-Doc function
 * header. Declaration-side visibility entries and other symbol data are
 * preserved, and the aggregate is recomputed from the remaining entries.
 */
export function clearVisibility(symbol: CoreSymbol): void {
	const root = asRecord(symbol.data)
	const previous = getImpDocSymbolData(symbol.data)
	if (!previous) {
		return
	}

	const impDoc: ImpDocSymbolData = { ...previous }
	delete impDoc.visibility
	delete impDoc.privateOwner
	delete symbol.desc

	if (Object.keys(impDoc).length === 0) {
		delete root['impDoc']
		symbol.data = root
		// SymbolVisibility.Public = 2 (const enum; use the runtime numeric value).
		symbol.visibility = 2
		delete symbol.visibilityRestriction
		return
	}

	refreshAggregateVisibility(symbol, impDoc)
	root['impDoc'] = impDoc
	symbol.data = root
}
