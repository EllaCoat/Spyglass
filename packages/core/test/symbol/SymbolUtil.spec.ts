import type { SymbolTable } from '@spyglassmc/core'
import { SymbolFormatter, SymbolUtil } from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('SymbolUtil', () => {
	const fileUri = 'spyglassmc://test_file'
	const anotherFileUri = 'spyglassmc://another_test_file'
	describe('contributeAs', () => {
		it('Should execute correctly', (t) => {
			const symbols = new SymbolUtil({})
			symbols.contributeAs('uri_binder', () => {
				symbols.query(fileUri, 'test', 'Bound').enter({
					data: { desc: 'This symbol is URI bound.' },
					usage: {},
				})
			})
			t.assert.snapshot(SymbolFormatter.stringifySymbolTable(symbols.global))
		})
	})
	describe('clear()', () => {
		it('Should clear all', (t) => {
			// Set up the symbol table.
			const global: SymbolTable = {}
			const symbols = new SymbolUtil(global)
			symbols.query(fileUri, 'mcdoc', 'ShouldBeKept1').enter({ usage: { type: 'definition' } })
				.member('ShouldBeRemoved1', (memberQuery) => {
					memberQuery.enter({ usage: { type: 'definition' } })
				}).member('ShouldBeKept2', (memberQuery) => {
					memberQuery.enter({ usage: { type: 'definition' } })
				})
			symbols.query(anotherFileUri, 'mcdoc', 'ShouldBeKept1', 'ShouldBeKept2').enter({
				usage: { type: 'definition' },
			})
			symbols.query(anotherFileUri, 'mcdoc', 'ShouldBeKept3').enter({
				usage: { type: 'definition' },
			}).member('ShouldBeKept4', (memberQuery) => {
				memberQuery.enter({ usage: { type: 'definition' } })
			}).member('ShouldBeKept5', (memberQuery) => {
				memberQuery.enter({ usage: { type: 'definition' } })
			})
			symbols.query(fileUri, 'mcdoc', 'ShouldBeKept3').member(
				'ShouldBeRemoved3',
				(memberQuery) => {
					memberQuery.enter({ usage: { type: 'definition' } })
				},
			).member('ShouldBeKept5', (memberQuery) => {
				memberQuery.enter({ usage: { type: 'definition' } })
			})
			t.assert.snapshot(SymbolFormatter.stringifySymbolTable(symbols.global))

			symbols.clear({ uri: fileUri })
			t.assert.snapshot(SymbolFormatter.stringifySymbolTable(symbols.global))
		})
	})
	describe('getSymbolCandidatesAtUri()', () => {
		const identifiersAt = (symbols: SymbolUtil, uri: string) =>
			symbols.getSymbolCandidatesAtUri(uri).map((symbol) => symbol.identifier).sort()

		it('Should return symbols that contributed locations to the URI', () => {
			const symbols = new SymbolUtil({})
			symbols.query(fileUri, 'mcdoc', 'Parent').enter({ usage: { type: 'definition' } })
				.member('Member', (memberQuery) => {
					memberQuery.enter({ usage: { type: 'definition' } })
				})
			symbols.query(anotherFileUri, 'mcdoc', 'Elsewhere').enter({
				usage: { type: 'definition' },
			})

			assert.deepEqual(identifiersAt(symbols, fileUri), ['Member', 'Parent'])
			assert.deepEqual(identifiersAt(symbols, anotherFileUri), ['Elsewhere'])
			assert.deepEqual(identifiersAt(symbols, 'spyglassmc://unknown'), [])
		})
		it('Should keep stale superset entries after locations are cleared from the URI', () => {
			const symbols = new SymbolUtil({})
			symbols.query(fileUri, 'mcdoc', 'Moved').enter({ usage: { type: 'definition' } })
			symbols.query(anotherFileUri, 'mcdoc', 'Moved').enter({ usage: { type: 'definition' } })

			symbols.clear({ uri: fileUri })

			// The reverse cache intentionally keeps stale entries: `Moved` no longer
			// has a location at `fileUri` but is still returned as a candidate. It is
			// the caller's responsibility to re-verify the locations.
			const candidates = symbols.getSymbolCandidatesAtUri(fileUri)
			assert.deepEqual(candidates.map((symbol) => symbol.identifier), ['Moved'])
			assert.ok(
				!candidates.some((symbol) =>
					symbol.definition?.some((location) => location.uri === fileUri)
				),
			)
		})
		it('Should drop entries whose symbols were trimmed from the table', () => {
			const symbols = new SymbolUtil({})
			symbols.query(fileUri, 'mcdoc', 'Trimmed').enter({ usage: { type: 'definition' } })

			symbols.clear({ uri: fileUri })

			assert.deepEqual(identifiersAt(symbols, fileUri), [])
		})
		it('Should deduplicate symbols cached under multiple contributors', () => {
			const symbols = new SymbolUtil({})
			symbols.contributeAs('uri_binder', () => {
				symbols.query(fileUri, 'mcdoc', 'Shared').enter({ usage: { type: 'definition' } })
			})
			symbols.contributeAs('binder', () => {
				symbols.query(fileUri, 'mcdoc', 'Shared').enter({ usage: { type: 'reference' } })
			})

			assert.deepEqual(identifiersAt(symbols, fileUri), ['Shared'])
		})
		it('Should return an empty array until buildCache() indexes an existing table', () => {
			const symbols = new SymbolUtil({})
			symbols.query(fileUri, 'mcdoc', 'Existing').enter({ usage: { type: 'definition' } })

			const rebuilt = new SymbolUtil(symbols.global)
			assert.deepEqual(rebuilt.getSymbolCandidatesAtUri(fileUri), [])

			rebuilt.buildCache()
			assert.deepEqual(identifiersAt(rebuilt, fileUri), ['Existing'])
		})
	})
	describe('lookup()', () => {
		// Set up the symbol table.
		const symbols = new SymbolUtil({})
		symbols.query(fileUri, 'advancement', 'Foo').enter({ usage: { type: 'definition' } }).member(
			'Bar',
			(member) =>
				member.enter({ usage: { type: 'definition' } }).member(
					'Qux',
					(member) => member.enter({ usage: { type: 'definition' } }),
				),
		)
		// const stackSymbols = new SymbolUtil({})
		// stackSymbols
		// 	.query(fileUri, 'advancement', 'Foo')
		// 	.enter({
		// 		data: { desc: 'STACK' },
		// 		usage: { type: 'definition' },
		// 	})
		// 	.member('Baz', member => member
		// 		.enter({
		// 			data: { desc: 'STACK' },
		// 			usage: { type: 'definition' },
		// 		})
		// 	)
		// symbols._setStack(fileUri, [stackSymbols.global])

		const paths: string[][] = [
			[],
			['Unknown'],
			['Foo'],
			['Foo', 'Unknown'],
			['Foo', 'Bar'],
			['Foo', 'Bar', 'Unknown'],
			['Foo', 'Bar', 'Qux'],
			['Foo', 'Bar', 'Qux', 'Xer'],
			['Foo', 'Baz'],
			['Foo', 'Baz', 'Xer'],
		]
		for (const path of paths) {
			it(`Should return correctly for “${path.join('.')}”`, (t) => {
				const actual = symbols.lookup('advancement', path)

				t.assert.snapshot(SymbolFormatter.stringifyLookupResult(actual))
			})
		}
		it('Should return correctly when URI is not specified', (t) => {
			const actual = symbols.lookup('advancement', ['Foo'])

			t.assert.snapshot(SymbolFormatter.stringifyLookupResult(actual))
		})
	})
	describe('query()', () => {
		const paths: string[][] = [
			['Unknown'],
			['Foo'],
			['Foo', 'Unknown'],
			['Foo', 'Bar'],
			['Foo', 'Bar', 'Unknown'],
			['Foo', 'Bar', 'Qux'],
			['Foo', 'Bar', 'Qux', 'Xer'],
			['Foo', 'Baz'],
			['Foo', 'Baz', 'Xer'],
		]
		for (const path of paths) {
			it(`Should return correctly for “${path.join('.')}”`, (t) => {
				const symbols = new SymbolUtil({})
				symbols.query(fileUri, 'advancement', 'Foo').enter({ usage: { type: 'definition' } })
					.member(
						'Bar',
						(member) =>
							member.enter({ usage: { type: 'definition' } }).member(
								'Qux',
								(member) => member.enter({ usage: { type: 'definition' } }),
							),
					)

				const query = symbols.query(fileUri, 'advancement', ...path)

				t.assert.snapshot(SymbolFormatter.stringifySymbol(query.symbol))

				try {
					query.enter({ data: { desc: 'Entered.' } })
				} catch (e) {
					t.assert.snapshot(`${e}`)
				}

				t.assert.snapshot(SymbolFormatter.stringifySymbol(query.symbol))
				t.assert.snapshot(SymbolFormatter.stringifySymbolTable(symbols.global))
			})
		}
	})
})
