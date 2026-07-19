/* eslint-disable no-restricted-syntax -- The manifest contract requires a literal null mapping. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	getLegacyCategorySpec,
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

	it('records the exceptional mappings and legacy identifier families', () => {
		assert.deepEqual(getLegacyCategorySpec('sequence'), {
			id: 'sequence',
			family: 'plain-variable',
			v4Category: 'random_sequence',
			namespaced: false,
			nativeSupport: 'mapped',
		})
		assert.deepEqual(getLegacyCategorySpec('worldgen/configured_decorator'), {
			id: 'worldgen/configured_decorator',
			family: 'namespaced',
			v4Category: null,
			namespaced: true,
			nativeSupport: 'not-in-v4',
		})
		assert.equal(getLegacyCategorySpec('entity')?.family, 'entity-like')
		assert.equal(getLegacyCategorySpec('score_holder')?.family, 'entity-like')
		for (const id of ['objective', 'tag', 'team'] as const) {
			assert.equal(getLegacyCategorySpec(id)?.family, 'plain-variable')
		}
		for (const spec of LEGACY_ALIAS_TYPES) {
			assert.equal(spec.family, 'alias')
			assert.equal(spec.nativeSupport, 'plugin-local')
		}
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
