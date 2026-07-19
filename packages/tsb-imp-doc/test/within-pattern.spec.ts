import { ErrorReporter, StateProxy } from '@spyglassmc/core'
import type { Symbol as CoreSymbol } from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getImpDocSymbolData } from '../lib/index.js'
import type {
	ImpDocAnnotation,
	ImpDocDeclarationSource,
	ImpDocDeclarationVisibility,
	ImpDocValue,
} from '../lib/index.js'
import {
	LEGACY_FILE_TYPE_IDS,
	LEGACY_MISC_TYPES,
	LEGACY_WITHIN_TARGET_IDS,
} from '../lib/legacy/categories.js'
import {
	clearVisibility,
	getCanonicalDeclarationOwnerUri,
	legacyGlobToRegex,
	matchesVisibility,
	parseVisibility,
	stampVisibility,
	toShortestString,
	visibilityRestrictions,
} from '../lib/util/withinPattern.js'

function value(raw: string): ImpDocValue {
	return { raw, range: { start: 0, end: raw.length } }
}

function annotation(...tokens: string[]): ImpDocAnnotation {
	const [head, ...rest] = tokens
	const node: ImpDocAnnotation = {
		type: 'impDoc:annotation',
		range: { start: 0, end: 0 },
		value: value(head!),
	}
	// 実 parser (parseAnnotations) は space 区切りを nested child として保持する
	// ため、 sibling ではなく chain で組み立てる。 flattenAnnotations も chain 前提。
	if (rest.length) {
		node.children = [annotation(...rest)]
	}
	return node
}

describe('legacyGlobToRegex', () => {
	it('anchors exact identifiers', () => {
		assert.equal(legacyGlobToRegex('foo:bar'), '^foo:bar$')
	})
	it('translates ? to exactly one non-separator character', () => {
		const regexp = new RegExp(legacyGlobToRegex('foo:?'))
		assert.equal(legacyGlobToRegex('foo:?'), '^foo:[^:/]$')
		assert.equal(regexp.test('foo:a'), true)
		assert.equal(regexp.test('foo:'), false)
		assert.equal(regexp.test('foo:ab'), false)
		assert.equal(regexp.test('foo:/'), false)
		assert.equal(regexp.test('foo::'), false)
	})
	it('translates * to a zero-or-more non-separator wildcard', () => {
		const regexp = new RegExp(legacyGlobToRegex('foo:*'))
		assert.equal(regexp.test('foo:'), true)
		assert.equal(regexp.test('foo:bar'), true)
		assert.equal(regexp.test('foo:bar/baz'), false)
		assert.equal(regexp.test('foo:bar:baz'), false)
		assert.equal(legacyGlobToRegex('foo:bar/*'), '^foo:bar/[^:/]{0,}$')
	})
	it('translates **/ before ** and permits a zero-segment match', () => {
		const regexp = new RegExp(legacyGlobToRegex('foo/**/leaf'))
		assert.equal(legacyGlobToRegex('foo/**/leaf'), '^foo/.{0,}leaf$')
		assert.equal(regexp.test('foo/leaf'), true)
		assert.equal(regexp.test('foo/deep/path/leaf'), true)
		assert.equal(regexp.test('foo/deep:path/leaf'), true)
	})
	it('translates ** to a separator-crossing wildcard', () => {
		const regexp = new RegExp(legacyGlobToRegex('foo:**'))
		assert.equal(regexp.test('foo:'), true)
		assert.equal(regexp.test('foo:bar/baz'), true)
		assert.equal(regexp.test('foo:bar:baz'), true)
		assert.equal(legacyGlobToRegex('foo:bar/**'), '^foo:bar/.{0,}$')
	})
	it('escapes regex meta characters', () => {
		assert.equal(
			legacyGlobToRegex('foo:bar.baz+qux(1)'),
			'^foo:bar\\.baz\\+qux\\(1\\)$',
		)
	})
	it('handles mixed * and ** in a single path', () => {
		assert.equal(
			legacyGlobToRegex('a/*/b/**/c'),
			'^a/[^:/]{0,}/b/.{0,}c$',
		)
	})
	it('preserves legacy sequential replacement semantics for overlaps', () => {
		for (
			const [pattern, expected] of [
				['***/', '^[^:/]{0,}.{0,}$'],
				['****/', '^.{0,}.{0,}$'],
				['**?/', '^.{0,}[^:/]/$'],
				['***?/', '^.{0,}[^:/]{0,}[^:/]/$'],
				['?**/', '^[^:/].{0,}$'],
			] as const
		) {
			assert.equal(legacyGlobToRegex(pattern), expected, pattern)
		}
	})
})

describe('parseVisibility', () => {
	const owner = 'owner:helper'

	it('returns undefined when no visibility annotation is present', () => {
		const result = parseVisibility([annotation('@deprecated')], owner)
		assert.equal(result, undefined)
	})

	it('returns public when @public is present', () => {
		const result = parseVisibility([annotation('@public')], owner)
		assert.deepEqual(result, { type: 'public' })
	})

	it('treats @api as public for legacy parity', () => {
		const result = parseVisibility([annotation('@api')], owner)
		assert.deepEqual(result, { type: 'public' })
	})

	it('lets @public take precedence when combined with @private', () => {
		const result = parseVisibility(
			[annotation('@public'), annotation('@private')],
			owner,
		)
		assert.deepEqual(result, { type: 'public' })
	})

	it('returns private for a lone @private', () => {
		const result = parseVisibility([annotation('@private')], owner)
		assert.deepEqual(result, { type: 'private', owner })
	})

	it('returns internal for a lone @internal', () => {
		const result = parseVisibility([annotation('@internal')], owner)
		assert.deepEqual(result, { type: 'internal', owner })
	})

	it('returns within for @within function <path>', () => {
		const result = parseVisibility(
			[annotation('@within', 'function', 'owner:main')],
			owner,
		)
		assert.deepEqual(result, {
			type: 'within',
			owner,
			includeOwner: false,
			patterns: [{
				raw: 'owner:main',
				targetType: 'function',
				regex: '^owner:main$',
			}],
		})
	})

	it('treats @within <path> shorthand as target type *', () => {
		const result = parseVisibility(
			[annotation('@within', 'owner:main')],
			owner,
		)
		assert.deepEqual(result, {
			type: 'within',
			owner,
			includeOwner: false,
			patterns: [{
				raw: 'owner:main',
				targetType: '*',
				regex: '^owner:main$',
			}],
		})
	})

	it('merges @private and @within as within with owner + patterns', () => {
		const result = parseVisibility(
			[
				annotation('@private'),
				annotation('@within', 'function', 'owner:main'),
			],
			owner,
		)
		assert.deepEqual(result, {
			type: 'within',
			owner,
			includeOwner: true,
			patterns: [{
				raw: 'owner:main',
				targetType: 'function',
				regex: '^owner:main$',
			}],
		})
	})

	it('collects multiple @within patterns as OR', () => {
		const result = parseVisibility(
			[
				annotation('@within', 'function', 'owner:main'),
				annotation('@within', 'function', 'other:allowed/**'),
			],
			owner,
		)
		assert.deepEqual(result, {
			type: 'within',
			owner,
			includeOwner: false,
			patterns: [
				{
					raw: 'owner:main',
					targetType: 'function',
					regex: '^owner:main$',
				},
				{
					raw: 'other:allowed/**',
					targetType: 'function',
					regex: '^other:allowed/.{0,}$',
				},
			],
		})
	})

	it('accepts all 47 legacy FileTypes and * as explicit targets', () => {
		assert.equal(LEGACY_FILE_TYPE_IDS.length, 47)
		assert.equal(LEGACY_WITHIN_TARGET_IDS.length, 48)
		for (const targetType of LEGACY_WITHIN_TARGET_IDS) {
			const err = new ErrorReporter()
			const result = parseVisibility(
				[annotation('@within', targetType, 'allowed:path')],
				owner,
				err,
			)
			assert.equal(result?.type, 'within', targetType)
			assert.equal(
				result?.type === 'within' ? result.patterns[0]?.targetType : undefined,
				targetType,
			)
			assert.deepEqual(err.errors, [], targetType)
		}
	})

	it('rejects all eight non-file MiscTypes as explicit targets', () => {
		assert.equal(LEGACY_MISC_TYPES.length, 8)
		for (const { id } of LEGACY_MISC_TYPES) {
			const err = new ErrorReporter()
			const result = parseVisibility(
				[annotation('@within', id, 'allowed:path')],
				owner,
				err,
			)
			assert.deepEqual(result, { type: 'denied', owner }, id)
			assert.ok(
				err.errors.some(error => error.message.includes('Unsupported @within target type')),
				id,
			)
		}
	})

	it('returns denied for each malformed @within shape', () => {
		for (
			const [name, malformed] of [
				['unknown target', annotation('@within', 'unknown_type', 'allowed:path')],
				['no arguments', annotation('@within')],
				['extra arguments', annotation('@within', 'function', 'tag1', 'tag2')],
			] as const
		) {
			const err = new ErrorReporter()
			assert.deepEqual(
				parseVisibility([malformed], owner, err),
				{ type: 'denied', owner },
				name,
			)
			assert.ok(
				err.errors.some(error => error.message.includes('falling back to deny state')),
				name,
			)
		}
	})

	it('makes malformed @within override public and other valid annotations', () => {
		for (
			const annotations of [
				[annotation('@public'), annotation('@within', 'unknown_type', 'x')],
				[annotation('@api'), annotation('@within')],
				[
					annotation('@internal'),
					annotation('@within', 'function', 'owner:allowed'),
					annotation('@within', 'function', 'one', 'two'),
				],
			]
		) {
			const err = new ErrorReporter()
			assert.deepEqual(
				parseVisibility(annotations, owner, err),
				{ type: 'denied', owner },
			)
			assert.ok(err.errors.some(error => error.message.includes('falling back to deny state')))
		}
	})

	it('reports diagnostic when owner is missing for restricted visibility', () => {
		const err = new ErrorReporter()
		const result = parseVisibility(
			[annotation('@private')],
			undefined,
			err,
		)
		assert.equal(result, undefined)
		assert.equal(err.errors.length, 1)
	})
})

describe('matchesVisibility', () => {
	it('allows any caller for public', () => {
		assert.equal(
			matchesVisibility({ type: 'public' }, 'anyone:x'),
			true,
		)
	})

	it('allows self reference for private', () => {
		assert.equal(
			matchesVisibility(
				{ type: 'private', owner: 'owner:helper' },
				'owner:helper',
			),
			true,
		)
	})

	it('rejects non-owner caller for private', () => {
		assert.equal(
			matchesVisibility(
				{ type: 'private', owner: 'owner:helper' },
				'other:caller',
			),
			false,
		)
	})

	it('treats denied as private owner-exact visibility', () => {
		assert.equal(
			matchesVisibility({ type: 'denied', owner: 'owner:helper' }, 'owner:helper'),
			true,
		)
		assert.equal(
			matchesVisibility({ type: 'denied', owner: 'owner:helper' }, 'owner:other'),
			false,
		)
	})

	it('allows @internal from the owner namespace or minecraft namespace', () => {
		const visibility = { type: 'internal' as const, owner: 'owner:helper' }
		assert.equal(matchesVisibility(visibility, 'owner:other/deep'), true)
		assert.equal(matchesVisibility(visibility, 'minecraft:load'), true)
		assert.equal(matchesVisibility(visibility, 'external:caller'), false)

		const defaultVisibility = {
			type: 'internal' as const,
			owner: 'minecraft:private',
		}
		assert.equal(matchesVisibility(defaultVisibility, 'minecraft:load'), true)
		assert.equal(matchesVisibility(defaultVisibility, 'owner:caller'), false)
	})

	it('tests both canonical and default-namespace-short caller forms', () => {
		assert.equal(toShortestString('minecraft:allowed/deep'), 'allowed/deep')
		assert.equal(toShortestString('custom:allowed/deep'), 'custom:allowed/deep')
		const visibility = parseVisibility(
			[annotation('@within', 'function', 'allowed/**')],
			'owner:helper',
		)
		assert.ok(visibility)
		assert.equal(matchesVisibility(visibility, 'minecraft:allowed/deep'), true)
	})

	it('allows owner or pattern match when @private accompanies @within', () => {
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [{
				raw: 'owner:main',
				targetType: 'function' as const,
				regex: '^owner:main$',
			}],
		}
		assert.equal(matchesVisibility(visibility, 'owner:helper'), true)
		assert.equal(matchesVisibility(visibility, 'owner:main'), true)
		assert.equal(matchesVisibility(visibility, 'other:caller'), false)
	})

	it('does not implicitly allow the owner for a lone @within', () => {
		const visibility = parseVisibility(
			[annotation('@within', 'function', 'owner:main')],
			'owner:helper',
		)
		assert.ok(visibility)
		assert.equal(visibility.type, 'within')
		assert.equal(
			visibility.type === 'within' ? visibility.includeOwner : undefined,
			false,
		)
		assert.equal(matchesVisibility(visibility, 'owner:helper'), false)
		assert.equal(matchesVisibility(visibility, 'owner:main'), true)
	})

	it('honors ** across slashes and * within a segment', () => {
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [
				{
					raw: 'other:allowed/**',
					targetType: 'function' as const,
					regex: '^other:allowed/.{0,}$',
				},
				{
					raw: 'other:leaf/*',
					targetType: 'function' as const,
					regex: '^other:leaf/[^:/]{0,}$',
				},
			],
		}
		assert.equal(matchesVisibility(visibility, 'other:allowed/deep/nested'), true)
		assert.equal(matchesVisibility(visibility, 'other:leaf/foo'), true)
		assert.equal(matchesVisibility(visibility, 'other:leaf/foo/bar'), false)
	})

	it('filters mixed targetType patterns against the caller type', () => {
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [
				{
					raw: 'star:allowed',
					targetType: '*' as const,
					regex: '^star:allowed$',
				},
				{
					raw: 'func:allowed',
					targetType: 'function' as const,
					regex: '^func:allowed$',
				},
			],
		}
		// caller type default 'function' は `*` pattern と `function` pattern の両方に届く。
		assert.equal(matchesVisibility(visibility, 'star:allowed'), true)
		assert.equal(matchesVisibility(visibility, 'func:allowed'), true)
		// caller type `*` を明示した場合、 `function` pattern は
		// `pattern.targetType === '*' || pattern.targetType === callerType` を満たさない。
		assert.equal(matchesVisibility(visibility, 'star:allowed', '*'), true)
		assert.equal(matchesVisibility(visibility, 'func:allowed', '*'), false)
	})

	it('falls back to owner-only matching for within with empty patterns', () => {
		// parseVisibility は patterns 空の within を生成しないが、 matchesVisibility 単体は
		// 空 iterable の `.some()` が false を返す道を defensive に持つ。 その挙動を pin。
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [],
		}
		assert.equal(matchesVisibility(visibility, 'owner:helper'), true)
		assert.equal(matchesVisibility(visibility, 'other:caller'), false)
	})

	it('evaluates patterns by value regardless of object identity', () => {
		// 同一 shape で identity が異なる pattern object でも判定は一致する。
		// 将来 cache を導入しても semantics が identity で分岐しないことの証跡。
		const makeVisibility = () => ({
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [{
				raw: 'other:allowed/**',
				targetType: 'function' as const,
				regex: '^other:allowed/.{0,}$',
			}],
		})
		const first = makeVisibility()
		const second = makeVisibility()
		assert.notEqual(first.patterns[0], second.patterns[0])
		assert.equal(matchesVisibility(first, 'other:allowed/deep'), true)
		assert.equal(matchesVisibility(second, 'other:allowed/deep'), true)
		assert.equal(matchesVisibility(first, 'denied:caller'), false)
		assert.equal(matchesVisibility(second, 'denied:caller'), false)
	})

	it('behaves identically after a JSON round-trip', () => {
		// WithinPattern は plain string 3 field のみで serialize 可能。 cache reload 経路
		// (JSON 化 → 復元) を通しても判定が変わらないことを pin。
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [
				{
					raw: 'owner:main',
					targetType: 'function' as const,
					regex: '^owner:main$',
				},
				{
					raw: 'other:allowed/**',
					targetType: '*' as const,
					regex: '^other:allowed/.{0,}$',
				},
			],
		}
		const reloaded = JSON.parse(JSON.stringify(visibility)) as typeof visibility
		assert.deepEqual(reloaded, visibility)
		assert.equal(matchesVisibility(reloaded, 'owner:helper'), true)
		assert.equal(matchesVisibility(reloaded, 'owner:main'), true)
		assert.equal(matchesVisibility(reloaded, 'other:allowed/deep/nested'), true)
		assert.equal(matchesVisibility(reloaded, 'denied:caller'), false)
		for (
			const caller of [
				'owner:helper',
				'owner:main',
				'other:allowed/deep/nested',
				'denied:caller',
			]
		) {
			assert.equal(
				matchesVisibility(reloaded, caller),
				matchesVisibility(visibility, caller),
			)
		}
	})

	it('evaluates non-canonical patterns through the per-pattern fallback path', () => {
		// raw と regex が食い違う pattern は unified regex (Option B) の canonical check
		// で弾かれ、 per-pattern cache (Option A) の順序付き評価に降りる。 fallback path
		// でも判定は pattern.regex 側で行われる semantics を pin。
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [{
				raw: 'foo:bar',
				targetType: 'function' as const,
				regex: '^completely/unrelated$',
			}],
		}
		assert.equal(matchesVisibility(visibility, 'owner:helper'), true)
		// raw ではなく regex が評価される (fallback path でも regex 基準)。
		assert.equal(matchesVisibility(visibility, 'completely/unrelated'), true)
		assert.equal(matchesVisibility(visibility, 'foo:bar'), false)
	})

	it('matches large canonical pattern sets through the unified regex path', () => {
		// 16 個の canonical pattern (raw から legacyGlobToRegex で生成) は visibility
		// 単位の unified regex (Option B) に畳まれる。 owner / 各 pattern match /
		// no-match の全系で per-pattern `.some()` と semantically 等価であることを pin。
		const patterns = Array.from({ length: 16 }, (_, i) => ({
			raw: `allowed:ns${i}/**`,
			targetType: 'function' as const,
			regex: legacyGlobToRegex(`allowed:ns${i}/**`),
		}))
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns,
		}
		assert.equal(matchesVisibility(visibility, 'owner:helper'), true)
		for (let i = 0; i < patterns.length; i++) {
			assert.equal(
				matchesVisibility(visibility, `allowed:ns${i}/deep/nested`),
				true,
			)
		}
		assert.equal(matchesVisibility(visibility, 'denied:ns0/deep'), false)
	})

	it('resolves explicit star caller type against *-only patterns', () => {
		// call site は現状すべて callerType 'function' だが、 `*` 経路の prepared regex
		// も独立に引けることを pin (caller type 別 cache の将来 proofing)。
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [{
				raw: 'star:allowed/**',
				targetType: '*' as const,
				regex: '^star:allowed/.{0,}$',
			}],
		}
		assert.equal(matchesVisibility(visibility, 'star:allowed/deep', '*'), true)
		assert.equal(matchesVisibility(visibility, 'denied:caller', '*'), false)
	})

	it('compiles unified regexes lazily for each first-touched caller type', () => {
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [{
				raw: 'allowed:**',
				targetType: '*' as const,
				regex: legacyGlobToRegex('allowed:**'),
			}],
		}
		const OriginalRegExp = globalThis.RegExp
		let compileCount = 0
		class SpiedRegExp extends OriginalRegExp {
			constructor(source: string | RegExp, flags?: string) {
				super(source, flags)
				compileCount++
			}
		} // deno-lint-ignore no-explicit-any

		;(globalThis as any).RegExp = SpiedRegExp
		try {
			assert.equal(matchesVisibility(visibility, 'allowed:function'), true)
			assert.equal(compileCount, 1)
			assert.equal(matchesVisibility(visibility, 'allowed:again'), true)
			assert.equal(compileCount, 1)
			assert.equal(
				matchesVisibility(visibility, 'allowed:loot', 'loot_table'),
				true,
			)
			assert.equal(compileCount, 2)
		} finally {
			// deno-lint-ignore no-explicit-any
			;(globalThis as any).RegExp = OriginalRegExp
		}
	})

	it('reuses unified regex cache across different StateProxy identities', () => {
		// 実 linter は candidate ごとに別 StateProxy handler を通すため、 同一 origin visibility でも
		// proxy identity が毎回異なる。 `StateProxy.dereference()` で origin を key にするため、
		// 別 proxy で包んで二度呼んでも unified regex の追加 compile は発生しない (canonical 経路)。
		const originVisibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [
				{
					raw: 'other:allowed/**',
					targetType: 'function' as const,
					regex: '^other:allowed/.{0,}$',
				},
				{
					raw: 'other:leaf/*',
					targetType: 'function' as const,
					regex: '^other:leaf/[^:/]{0,}$',
				},
			],
		}
		const OriginalRegExp = globalThis.RegExp
		let compileCount = 0
		class SpiedRegExp extends OriginalRegExp {
			constructor(source: string | RegExp, flags?: string) {
				super(source, flags)
				compileCount++
			}
		} // deno-lint-ignore no-explicit-any

		;(globalThis as any).RegExp = SpiedRegExp
		try {
			const proxy1 = StateProxy.create(originVisibility)
			const proxy2 = StateProxy.create(originVisibility)
			assert.equal(
				matchesVisibility(
					proxy1 as unknown as typeof originVisibility,
					'other:allowed/deep/nested',
				),
				true,
			)
			const afterFirst = compileCount
			assert.equal(
				matchesVisibility(proxy2 as unknown as typeof originVisibility, 'other:leaf/foo'),
				true,
			)
			assert.equal(
				compileCount,
				afterFirst,
				'proxy2 の呼び出しでは追加 compile が発生しないこと (identity 正規化)',
			)
		} finally {
			// deno-lint-ignore no-explicit-any
			;(globalThis as any).RegExp = OriginalRegExp
		}
	})

	it('reuses @internal regexes across different StateProxy identities', () => {
		const originVisibility = {
			type: 'internal' as const,
			owner: 'owner:helper',
		}
		const OriginalRegExp = globalThis.RegExp
		let compileCount = 0
		class SpiedRegExp extends OriginalRegExp {
			constructor(source: string | RegExp, flags?: string) {
				super(source, flags)
				compileCount++
			}
		} // deno-lint-ignore no-explicit-any

		;(globalThis as any).RegExp = SpiedRegExp
		try {
			const proxy1 = StateProxy.create(originVisibility)
			const proxy2 = StateProxy.create(originVisibility)
			assert.equal(
				matchesVisibility(proxy1 as unknown as typeof originVisibility, 'owner:allowed'),
				true,
			)
			const afterFirst = compileCount
			assert.equal(afterFirst, 2)
			assert.equal(
				matchesVisibility(proxy2 as unknown as typeof originVisibility, 'minecraft:load'),
				true,
			)
			assert.equal(compileCount, afterFirst)
		} finally {
			// deno-lint-ignore no-explicit-any
			;(globalThis as any).RegExp = OriginalRegExp
		}
	})

	it('reuses per-pattern cache in fallback path across StateProxy identities', () => {
		// canonical 外 pattern を持つ visibility は Option B の fallback path (per-pattern `.some()`) に
		// 降ろされる。 fallback 経路でも `matchesVisibility` が visibility 側を origin に正規化してから
		// `key.patterns` を反復するため、 per-pattern も origin element を key に cache hit する。
		// 別 proxy で二度呼んでも追加 compile は発生しないことを pin (visibility-level 正規化の検証)。
		const originVisibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			includeOwner: true,
			patterns: [
				{
					// canonical 外 : raw と regex が不整合 → PreparedFallback 発火
					raw: 'foo:bar',
					targetType: 'function' as const,
					regex: '^completely/unrelated$',
				},
			],
		}
		const OriginalRegExp = globalThis.RegExp
		let compileCount = 0
		class SpiedRegExp extends OriginalRegExp {
			constructor(source: string | RegExp, flags?: string) {
				super(source, flags)
				compileCount++
			}
		} // deno-lint-ignore no-explicit-any

		;(globalThis as any).RegExp = SpiedRegExp
		try {
			const proxy1 = StateProxy.create(originVisibility)
			const proxy2 = StateProxy.create(originVisibility)
			assert.equal(
				matchesVisibility(proxy1 as unknown as typeof originVisibility, 'completely/unrelated'),
				true,
			)
			const afterFirst = compileCount
			assert.equal(
				matchesVisibility(proxy2 as unknown as typeof originVisibility, 'completely/unrelated'),
				true,
			)
			assert.equal(
				compileCount,
				afterFirst,
				'proxy2 の fallback 呼び出しでは追加 compile が発生しないこと',
			)
		} finally {
			// deno-lint-ignore no-explicit-any
			;(globalThis as any).RegExp = OriginalRegExp
		}
	})
})

describe('visibilityRestrictions', () => {
	it('returns undefined for public', () => {
		assert.equal(
			visibilityRestrictions({ type: 'public' }),
			undefined,
		)
	})

	it('returns owner regex for private', () => {
		assert.deepEqual(
			visibilityRestrictions({ type: 'private', owner: 'owner:helper' }),
			['^owner:helper$'],
		)
	})

	it('returns owner regex for denied', () => {
		assert.deepEqual(
			visibilityRestrictions({ type: 'denied', owner: 'owner:helper' }),
			['^owner:helper$'],
		)
	})

	it('returns both legacy namespace patterns for non-default @internal', () => {
		assert.deepEqual(
			visibilityRestrictions({ type: 'internal', owner: 'owner:helper' }),
			['^owner:.{0,}$', '^minecraft:.{0,}$'],
		)
	})

	it('returns owner plus pattern regexes when includeOwner is true', () => {
		assert.deepEqual(
			visibilityRestrictions({
				type: 'within',
				owner: 'owner:helper',
				includeOwner: true,
				patterns: [
					{
						raw: 'owner:main',
						targetType: 'function',
						regex: '^owner:main$',
					},
				],
			}),
			['^owner:helper$', '^owner:main$'],
		)
	})

	it('omits the owner regex when includeOwner is false', () => {
		assert.deepEqual(
			visibilityRestrictions({
				type: 'within',
				owner: 'owner:helper',
				includeOwner: false,
				patterns: [{
					raw: 'owner:main',
					targetType: 'function',
					regex: '^owner:main$',
				}],
			}),
			['^owner:main$'],
		)
	})
})

describe('clearVisibility', () => {
	const declaration: ImpDocDeclarationSource = {
		uri: 'file:///fixture/_index.d.mcfunction',
		range: { start: 10, end: 20 },
		owner: 'example:owner',
		description: 'Canonical declaration description',
	}

	it('restores the canonical #declare description for a headerless symbol', () => {
		const symbol = { data: {} } as CoreSymbol
		stampVisibility(
			symbol,
			{ type: 'private', owner: 'example:owner' },
			declaration,
		)
		symbol.desc = 'Stale header-derived description'

		clearVisibility(symbol)

		assert.equal(symbol.desc, 'Canonical declaration description')
		assert.deepEqual(
			getImpDocSymbolData(symbol.data)?.declarations?.map(entry => entry.uri),
			[declaration.uri],
		)
	})

	it('replaces a removed header description with the canonical #declare description', () => {
		const symbol = { data: {} } as CoreSymbol
		stampVisibility(symbol, { type: 'public' })
		stampVisibility(
			symbol,
			{ type: 'private', owner: 'example:owner' },
			declaration,
		)
		symbol.desc = 'Header description'

		clearVisibility(symbol)

		assert.equal(symbol.desc, 'Canonical declaration description')
		assert.equal(getImpDocSymbolData(symbol.data)?.visibility, undefined)
	})

	it('still drops the description when no declaration entry remains', () => {
		const symbol = { data: {} } as CoreSymbol
		stampVisibility(symbol, { type: 'public' })
		symbol.desc = 'Header description'

		clearVisibility(symbol)

		assert.equal(symbol.desc, undefined)
		assert.equal(getImpDocSymbolData(symbol.data), undefined)
	})
})

describe('getCanonicalDeclarationOwnerUri', () => {
	const definitionUri = 'file:///fixture/data/a/functions/target.mcfunction'
	const declarationUri = 'file:///fixture/data/b/functions/decl.mcfunction'
	const declarations: ImpDocDeclarationVisibility[] = [{
		uri: declarationUri,
		range: { start: 10, end: 20 },
		owner: 'b:decl',
		visibility: { type: 'private', owner: 'b:decl' },
	}]

	it('prefers the defining document of a function', () => {
		const symbol = {
			category: 'function',
			definition: [{ uri: definitionUri }],
		} as CoreSymbol
		assert.equal(
			getCanonicalDeclarationOwnerUri(symbol, declarations),
			definitionUri,
		)
	})

	it('falls back to the surviving declaration when the definition URI is being cleared', () => {
		// The URI clear hook computes the post-clear owner before core removes
		// the SymbolLocations, so the cleared URI must not claim ownership.
		const symbol = {
			category: 'function',
			definition: [{ uri: definitionUri }],
		} as CoreSymbol
		assert.equal(
			getCanonicalDeclarationOwnerUri(symbol, declarations, definitionUri),
			declarationUri,
		)
	})
})
