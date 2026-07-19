import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
	getImpDocSymbolData,
	impDoc,
	type ImpDocContract,
	type ImpDocDeclarationSource,
	type ImpDocNode,
	ImpDocVersion,
	type ImpDocVisibility,
	stampContract,
	stampVisibility,
} from '../lib/index.js'

const EmptyContract: ImpDocContract = {
	inputs: [],
	outputs: [],
	apis: [],
	users: [],
	deprecated: [],
}

function emptySymbol(): core.Symbol {
	return { data: {} } as core.Symbol
}

function alias(kind: string, expansion: string): unknown {
	const symbol = emptySymbol()
	symbol.data = { impDoc: { alias: { kind, expansion } } }
	return getImpDocSymbolData(symbol.data)
}

function stamp(
	visibility: ImpDocVisibility,
	declaration?: ImpDocDeclarationSource,
	contract?: ImpDocContract,
): unknown {
	const symbol = emptySymbol()
	stampVisibility(symbol, visibility, declaration)
	if (contract) {
		stampContract(symbol, contract)
	}
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
		const showcaseSource = await readFile(
			new URL('./fixtures/12-contract-showcase.mcfunction', import.meta.url),
			'utf8',
		)
		const showcase = impDoc(
			new core.Source(showcaseSource),
			{ err: new core.ErrorReporter() } as Parameters<typeof impDoc>[1],
		)
		assert.notEqual(showcase, core.Failure)
		const showcaseContract = (showcase as ImpDocNode).contract
		const actual = {
			impDocVersion: ImpDocVersion,
			alias: alias(
				'selectorTemplate',
				'@e[type=#example:hostile, distance=..16]',
			),
			public: stamp({ type: 'public' }, undefined, EmptyContract),
			private: stamp(
				{ type: 'private', owner: 'example:owner' },
				undefined,
				EmptyContract,
			),
			internal: stamp(
				{ type: 'internal', owner: 'example:owner' },
				undefined,
				EmptyContract,
			),
			denied: stamp(
				{ type: 'denied', owner: 'example:owner' },
				undefined,
				EmptyContract,
			),
			withinDeclaration: stamp({
				type: 'within',
				owner: 'example:owner',
				includeOwner: true,
				patterns: [{
					raw: 'example:allowed/**',
					targetType: 'function',
					regex: '^example:allowed/.{0,}$',
				}],
			}, declaration),
			union: (() => {
				const symbol = emptySymbol()
				stampVisibility(symbol, { type: 'public' })
				stampVisibility(
					symbol,
					{ type: 'private', owner: 'example:owner' },
					declaration,
				)
				return getImpDocSymbolData(symbol.data)
			})(),
			representativeContract: stamp(
				{ type: 'public' },
				undefined,
				{
					...showcaseContract,
					inputs: [showcaseContract.inputs[2]!],
				},
			),
		}

		assert.deepEqual(actual, expected)
	})
})
