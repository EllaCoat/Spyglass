/* eslint-disable no-restricted-syntax -- The manifest contract requires a literal null mapping. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	getCanonicalSymbolCategory,
	getLegacyCategorySpec,
	getLegacySpecsByCanonicalCategory,
	isLegacyFileType,
	isLegacyWithinTarget,
	LEGACY_ALIAS_TYPES,
	LEGACY_DECLARABLE_TYPES,
	LEGACY_FILE_TYPE_IDS,
	LEGACY_FILE_TYPES,
	LEGACY_MISC_TYPES,
	LEGACY_TAG_FILE_TYPES,
	LEGACY_WITHIN_TARGET_IDS,
	LEGACY_WORLDGEN_FILE_TYPES,
} from '../lib/legacy/categories.js'

describe('legacy category manifest', () => {
	it('pins the v3.4.19 55+3 category partition without duplicates', () => {
		assert.deepEqual(
			[
				LEGACY_FILE_TYPES.length,
				LEGACY_TAG_FILE_TYPES.length,
				LEGACY_WORLDGEN_FILE_TYPES.length,
				LEGACY_MISC_TYPES.length,
				LEGACY_DECLARABLE_TYPES.length,
				LEGACY_ALIAS_TYPES.length,
			],
			[10, 21, 16, 8, 55, 3],
		)
		const all = [...LEGACY_DECLARABLE_TYPES, ...LEGACY_ALIAS_TYPES]
		assert.equal(new Set(all.map(spec => spec.id)).size, 58)
		assert.equal(LEGACY_FILE_TYPE_IDS.length, 47)
		assert.equal(LEGACY_WITHIN_TARGET_IDS.length, 48)
	})

	it('routes sequence through the canonical resource-location consumer', () => {
		assert.deepEqual(getLegacyCategorySpec('sequence'), {
			id: 'sequence',
			family: 'plain-variable',
			v4Category: 'random_sequence',
			namespaced: false,
			nativeSupport: 'mapped',
			consumerKind: 'resource-location',
		})
	})

	it('records the exceptional mappings and legacy identifier families', () => {
		assert.deepEqual(getLegacyCategorySpec('worldgen/configured_decorator'), {
			id: 'worldgen/configured_decorator',
			family: 'namespaced',
			v4Category: null,
			namespaced: true,
			nativeSupport: 'not-in-v4',
			consumerKind: 'resource-location',
		})
		// spike 1: core `DatapackCategories` has no `entity` category, so the
		// v3 `entity` misc type is plugin-local, not native.
		assert.deepEqual(getLegacyCategorySpec('entity'), {
			id: 'entity',
			family: 'entity-like',
			v4Category: 'entity',
			namespaced: false,
			nativeSupport: 'plugin-local',
			consumerKind: 'entity',
		})
		assert.equal(getLegacyCategorySpec('score_holder')?.family, 'entity-like')
		assert.equal(getLegacyCategorySpec('score_holder')?.consumerKind, 'score-holder')
		for (const id of ['objective', 'tag', 'team'] as const) {
			assert.equal(getLegacyCategorySpec(id)?.family, 'plain-variable')
			assert.equal(getLegacyCategorySpec(id)?.consumerKind, 'symbol')
		}
		for (const spec of LEGACY_ALIAS_TYPES) {
			assert.equal(spec.family, 'alias')
			assert.equal(spec.nativeSupport, 'plugin-local')
			assert.equal(spec.consumerKind, 'alias')
		}
		for (const spec of LEGACY_DECLARABLE_TYPES) {
			if (spec.family === 'namespaced') {
				assert.equal(spec.consumerKind, 'resource-location', spec.id)
			}
		}
	})

	it('maps every category onto one canonical symbol category', () => {
		assert.equal(getCanonicalSymbolCategory('sequence'), 'random_sequence')
		assert.equal(getCanonicalSymbolCategory('function'), 'function')
		assert.equal(
			getCanonicalSymbolCategory('worldgen/configured_decorator'),
			'worldgen/configured_decorator',
		)
		// Unknown ids stay lossless (TSB dialect extensions).
		assert.equal(
			getCanonicalSymbolCategory('alias/selectorTemplate'),
			'alias/selectorTemplate',
		)

		assert.deepEqual(
			getLegacySpecsByCanonicalCategory('random_sequence').map(spec => spec.id),
			['sequence'],
		)
		// No canonical table is named `sequence` anymore.
		assert.deepEqual(getLegacySpecsByCanonicalCategory('sequence'), [])
		assert.deepEqual(
			getLegacySpecsByCanonicalCategory('function').map(spec => spec.id),
			['function'],
		)
		assert.deepEqual(getLegacySpecsByCanonicalCategory('unknown'), [])
	})

	it('exposes constant-time membership and lookup helpers', () => {
		assert.equal(isLegacyFileType('function'), true)
		assert.equal(isLegacyFileType('bossbar'), false)
		assert.equal(isLegacyWithinTarget('tag/function'), true)
		assert.equal(isLegacyWithinTarget('*'), true)
		assert.equal(isLegacyWithinTarget('storage'), false)
		assert.equal(getLegacyCategorySpec('alias/vector')?.family, 'alias')
		assert.equal(getLegacyCategorySpec('unknown'), undefined)
	})
})
