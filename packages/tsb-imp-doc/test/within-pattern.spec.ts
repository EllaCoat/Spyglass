import { ErrorReporter } from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
	ImpDocAnnotation,
	ImpDocValue,
} from '../lib/index.js'
import {
	legacyGlobToRegex,
	matchesVisibility,
	parseVisibility,
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
	it('translates * to non-slash wildcard', () => {
		assert.equal(legacyGlobToRegex('foo:bar/*'), '^foo:bar/[^/]*$')
	})
	it('translates ** to slash-crossing wildcard', () => {
		assert.equal(legacyGlobToRegex('foo:bar/**'), '^foo:bar/.*$')
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
			'^a/[^/]*/b/.*/c$',
		)
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

	it('returns within for @within function <path>', () => {
		const result = parseVisibility(
			[annotation('@within', 'function', 'owner:main')],
			owner,
		)
		assert.deepEqual(result, {
			type: 'within',
			owner,
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
			patterns: [
				{
					raw: 'owner:main',
					targetType: 'function',
					regex: '^owner:main$',
				},
				{
					raw: 'other:allowed/**',
					targetType: 'function',
					regex: '^other:allowed/.*$',
				},
			],
		})
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

	it('allows owner or pattern match for within', () => {
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
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

	it('honors ** across slashes and * within a segment', () => {
		const visibility = {
			type: 'within' as const,
			owner: 'owner:helper',
			patterns: [
				{
					raw: 'other:allowed/**',
					targetType: 'function' as const,
					regex: '^other:allowed/.*$',
				},
				{
					raw: 'other:leaf/*',
					targetType: 'function' as const,
					regex: '^other:leaf/[^/]*$',
				},
			],
		}
		assert.equal(matchesVisibility(visibility, 'other:allowed/deep/nested'), true)
		assert.equal(matchesVisibility(visibility, 'other:leaf/foo'), true)
		assert.equal(matchesVisibility(visibility, 'other:leaf/foo/bar'), false)
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

	it('returns owner plus pattern regexes for within', () => {
		assert.deepEqual(
			visibilityRestrictions({
				type: 'within',
				owner: 'owner:helper',
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
})
