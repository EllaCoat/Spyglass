// core の Symbol 型は global Symbol constructor (unique symbol 宣言で使用) と
// 衝突するため alias で import する。
import type { ErrorReporter, Symbol as CoreSymbol } from '@spyglassmc/core'
import type {
	ImpDocAnnotation,
	ImpDocDeclarationSource,
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
	const entry = compiledPatternCache.get(pattern)
	// source 一致確認は defense in depth (同一 identity のまま regex が書き換わる
	// ケースは想定外だが、 食い違ったら新 entry で上書きする)。
	if (entry && entry.source === pattern.regex) {
		return entry.regexp
	}
	// flag は付けない (g / y は lastIndex が呼び出し間で残り判定が非決定的になる)。
	const regexp = new RegExp(pattern.regex)
	compiledPatternCache.set(pattern, { source: pattern.regex, regexp })
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
interface PreparedVisibility {
	function: PreparedRegExp
	star: PreparedRegExp
}
const preparedVisibilityCache: WeakMap<
	Extract<ImpDocVisibility, { type: 'within' }>,
	PreparedVisibility
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
	const applicable = patterns.filter(pattern =>
		pattern.targetType === '*' || pattern.targetType === callerType
	)
	// 空 alternation `(?:)` は全 match (= default-allow bug) になるため regex を作らない。
	if (applicable.length === 0) {
		return undefined
	}
	// 累積長で判定 (map().join() 一括構築だと巨大 pattern set で無駄な一時文字列を確保する)。
	let unifiedLength = 0
	const sources: string[] = []
	for (const pattern of applicable) {
		// canonical 外 (raw から regex を再導出できない) は Option A の semantics を保護
		// するため per-pattern 評価に降ろす。
		if (
			pattern.regex !== legacyGlobToRegex(pattern.raw)
			|| pattern.regex.length > MaxPatternSourceLength
		) {
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
	try {
		// flag は付けない (g / y は lastIndex が呼び出し間で残り判定が非決定的になる)。
		return new RegExp(sources.join('|'))
	} catch {
		return PreparedFallback
	}
}

function prepareVisibility(
	visibility: Extract<ImpDocVisibility, { type: 'within' }>,
): PreparedVisibility {
	return {
		function: buildPreparedRegExp(visibility.patterns, 'function'),
		star: buildPreparedRegExp(visibility.patterns, '*'),
	}
}

/**
 * Legacy IMP-Doc の path pattern を anchored regex source に変換する。
 * `*` は `/` を跨がない、 `**` は `/` を跨ぐ、 その他 regex meta character は escape。
 */
export function legacyGlobToRegex(pattern: string): string {
	let ans = '^'
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]
		if (char === '*' && pattern[i + 1] === '*') {
			ans += '.*'
			i++
		} else if (char === '*') {
			ans += '[^/]*'
		} else {
			ans += RegexSpecials.has(char) ? `\\${char}` : char
		}
	}
	return `${ans}$`
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

	if (targetType !== '*' && targetType !== 'function') {
		err?.report(
			`Unsupported @within target type "${targetType}"`,
			first,
		)
		return undefined
	}

	return {
		raw,
		targetType: targetType as WithinTargetType,
		regex: legacyGlobToRegex(raw),
	}
}

/**
 * annotation 群から visibility を解析。 `@public` (と Legacy 別名 `@api`) が含まれれば
 * unrestricted。 `@private` と `@within` は OR で合成、 owner に自己参照 + patterns の
 * いずれかで許可。
 */
export function parseVisibility(
	annotations: readonly ImpDocAnnotation[],
	owner: string | undefined,
	err?: ErrorReporter,
): ImpDocVisibility | undefined {
	let isPublic = false
	let isPrivate = false
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
			case '@within': {
				const pattern = parseWithin(values, err)
				if (pattern) {
					patterns.push(pattern)
				}
				break
			}
		}
	}

	if (isPublic) {
		return { type: 'public' }
	}
	if (!isPrivate && patterns.length === 0) {
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
		return { type: 'within', owner, patterns }
	}
	return { type: 'private', owner }
}

/**
 * caller (= function identifier) が visibility の許可条件を満たすか判定。
 * public / undefined は defensive に許可、 private は owner exact、 within は owner
 * OR patterns。 targetType が `*` なら caller の kind を問わず match。
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
			return caller === visibility.owner
		case 'within': {
			if (caller === visibility.owner) {
				return true
			}
			let prepared = preparedVisibilityCache.get(visibility)
			if (!prepared) {
				prepared = prepareVisibility(visibility)
				preparedVisibilityCache.set(visibility, prepared)
			}
			const compiled = callerType === 'function' ? prepared.function : prepared.star
			if (compiled === undefined) {
				return false
			}
			if (compiled === PreparedFallback) {
				return visibility.patterns.some(pattern =>
					(pattern.targetType === '*' || pattern.targetType === callerType)
					&& getCompiledPatternRegExp(pattern).test(caller)
				)
			}
			return compiled.test(caller)
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
			return [legacyGlobToRegex(visibility.owner)]
		case 'within':
			return [
				legacyGlobToRegex(visibility.owner),
				...visibility.patterns
					.filter(p => p.targetType === '*' || p.targetType === 'function')
					.map(p => p.regex),
			]
	}
}

/**
 * symbol.data.impDoc に visibility metadata を stamp する。 public は
 * `privateOwner` を削除、 restricted は owner を反映。 declaration source を
 * 渡された場合 canonical location として保存。
 */
export function stampVisibility(
	symbol: CoreSymbol,
	visibility: ImpDocVisibility,
	declaration?: ImpDocDeclarationSource,
): void {
	const root = asRecord(symbol.data)
	const previous = getImpDocSymbolData(symbol.data)
	const impDoc: ImpDocSymbolData = {
		...previous,
		visibility,
		...(declaration ? { declaration } : {}),
	}

	if (visibility.type === 'public') {
		delete impDoc.privateOwner
	} else {
		impDoc.privateOwner = visibility.owner
	}

	symbol.data = { ...root, impDoc }
	// SymbolVisibility.Public = 2、 Restricted = 3 (const enum、 strip-types loader
	// では inline されないため数値を直接使用)。
	symbol.visibility = visibility.type === 'public' ? 2 : 3
	symbol.visibilityRestriction = visibilityRestrictions(visibility)
}

/**
 * Remove visibility metadata previously contributed by an IMP-Doc function
 * header. Other symbol data and canonical declaration metadata are preserved.
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

	if (Object.keys(impDoc).length === 0) {
		delete root['impDoc']
	} else {
		root['impDoc'] = impDoc
	}

	symbol.data = root
	delete symbol.desc
	// SymbolVisibility.Public = 2 (const enum; use the runtime numeric value).
	symbol.visibility = 2
	delete symbol.visibilityRestriction
}
