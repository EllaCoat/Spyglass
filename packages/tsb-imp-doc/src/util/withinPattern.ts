import type { ErrorReporter, Symbol } from '@spyglassmc/core'
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
		case 'within':
			return caller === visibility.owner
				|| visibility.patterns.some(pattern =>
					(pattern.targetType === '*' || pattern.targetType === callerType)
					&& new RegExp(pattern.regex).test(caller)
				)
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
	symbol: Symbol,
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
export function clearVisibility(symbol: Symbol): void {
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
