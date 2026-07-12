import type { Symbol as SpyglassSymbol } from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
	getImpDocSymbolData,
	type ImpDocDeclarationSource,
	ImpDocVersion,
	type ImpDocVisibility,
	stampVisibility,
} from '../lib/index.js'

function emptySymbol(): SpyglassSymbol {
	return { data: {} } as SpyglassSymbol
}

function stamp(
	visibility: ImpDocVisibility,
	declaration?: ImpDocDeclarationSource,
): unknown {
	const symbol = emptySymbol()
	stampVisibility(symbol, visibility, declaration)
	return getImpDocSymbolData(symbol.data)
}

describe('Symbol.data.impDoc schema snapshot', () => {
	it('changes only through an intentional fixture and ImpDocVersion update', async () => {
		const expected = JSON.parse(
			await readFile(
				new URL('./fixtures/symbol-data-imp-doc.schema.json', import.meta.url),
				'utf8',
			),
		)
		const declaration: ImpDocDeclarationSource = {
			uri: 'file:///fixture/_index.d.mcfunction',
			range: { start: 10, end: 20 },
			owner: 'example:owner',
		}
		const actual = {
			impDocVersion: ImpDocVersion,
			public: stamp({ type: 'public' }),
			private: stamp({ type: 'private', owner: 'example:owner' }),
			withinDeclaration: stamp({
				type: 'within',
				owner: 'example:owner',
				patterns: [{
					raw: 'example:allowed/**',
					targetType: 'function',
					regex: '^example:allowed/.*$',
				}],
			}, declaration),
		}

		assert.deepEqual(actual, expected)
	})
})
