import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { stampAttachedSymbols } from '../lib/binder/attachedSymbols.js'
import { getImpDocSymbolData } from '../lib/index.js'
import type { ImpDocAnnotation, ImpDocContract, ImpDocNode, ImpDocValue } from '../lib/index.js'

const Owner = 'attached:owner'
const Uri = 'file:///data/attached/functions/owner.mcfunction'

const EmptyContract: ImpDocContract = {
	inputs: [],
	outputs: [],
	apis: [],
	users: [],
	deprecated: [],
}

function value(raw: string): ImpDocValue {
	return { raw, range: { start: 0, end: raw.length } }
}

function annotation(...tokens: string[]): ImpDocAnnotation {
	const [head, ...rest] = tokens
	const node: ImpDocAnnotation = {
		type: 'impDoc:annotation',
		range: { start: 0, end: 20 },
		value: value(head!),
	}
	if (rest.length) {
		node.children = [annotation(...rest)]
	}
	return node
}

/**
 * Own the real `SymbolUtil.lookup` / `.query` (used to pre-populate the
 * table) before swapping in throwing stand-ins as own-properties. Shadowing
 * as own-properties (instead of wrapping in a `Proxy`/`Object.create`) keeps
 * every other real method correctly bound to the private-field-carrying
 * instance while still making a `lookup()`/`query()` call from
 * `stampAttachedSymbols` fail loudly.
 */
function forbidGlobalSymbolScan(symbols: core.SymbolUtil): void {
	const guarded = symbols as unknown as { lookup: unknown; query: unknown }
	guarded.lookup = () => {
		throw new Error('stampAttachedSymbols must not call SymbolUtil.lookup()')
	}
	guarded.query = () => {
		throw new Error('stampAttachedSymbols must not call SymbolUtil.query()')
	}
}

describe('IMP-Doc attached binder (P4-3c)', () => {
	it("stamps an attached command's own definition site without scanning the URI's symbol table", () => {
		const definitionRange = { start: 100, end: 120 }
		const referenceRange = { start: 200, end: 210 }

		const table = core.SymbolTable.link({
			function: {
				[Owner]: { definition: [{ uri: Uri }] },
			},
			objective: {
				'attached.restricted_objective': {
					definition: [{ uri: Uri, range: definitionRange }],
				},
				'attached.unrelated_reference': {
					reference: [{ uri: Uri, range: referenceRange }],
				},
			},
		} as core.UnlinkedSymbolTable)
		const symbols = new core.SymbolUtil(table)
		symbols.buildCache()

		const definedSymbol = symbols.lookup('objective', ['attached.restricted_objective']).symbol
		assert.ok(definedSymbol)
		const referencedSymbol = symbols.lookup('objective', ['attached.unrelated_reference']).symbol
		assert.ok(referencedSymbol)

		// definition-site candidate: this is the node `isDefinitionOrDeclarationSite`
		// must accept (attached command's own (uri, range) match).
		const definitionCandidate: core.AstNode = {
			type: 'symbol',
			range: definitionRange,
			symbol: definedSymbol,
		}
		// reference-site candidate at a *different* range: must be skipped, mirroring
		// `linter/private.ts`'s reference/declaration split in the opposite direction.
		const referenceCandidate: core.AstNode = {
			type: 'symbol',
			range: referenceRange,
			symbol: referencedSymbol,
		}
		// symbol-less sibling: exercises the constant-cost early exit.
		const plainChild: core.AstNode = { type: 'mcfunction:literal', range: { start: 90, end: 95 } }

		const attachedRoot: core.AstNode = {
			type: 'mcfunction:command',
			range: { start: 90, end: 120 },
			children: [plainChild, referenceCandidate, definitionCandidate],
		}

		const doc: ImpDocNode = {
			type: 'impDoc',
			range: { start: 0, end: 130 },
			annotations: [annotation('@private')],
			contract: EmptyContract,
			functionID: value(Owner),
			children: [],
			attachedNodes: [attachedRoot],
			plainText: 'Attached objective doc',
			raw: '',
		}
		core.AstNode.setParents(doc)

		const err = new core.ErrorReporter()
		const ctx = {
			doc: {
				uri: Uri,
				languageId: 'mcfunction',
				version: 1,
				lineCount: 1,
				getText: () => '',
				offsetAt: (position: { character: number }) => position.character,
				positionAt: (offset: number) => ({ line: 0, character: offset }),
			},
			err,
			symbols,
		} as unknown as core.BinderContext

		forbidGlobalSymbolScan(symbols)

		assert.doesNotThrow(() => stampAttachedSymbols(doc, ctx))

		const stamped = getImpDocSymbolData(definedSymbol.data)
		assert.equal(stamped?.declarations?.length, 1)
		const entry = stamped!.declarations![0]!
		assert.equal(entry.uri, Uri)
		assert.deepEqual(entry.range, definitionRange)
		assert.equal(entry.owner, Owner)
		assert.match(entry.description ?? '', /^Attached objective doc/)
		assert.equal(definedSymbol.desc, entry.description)
		assert.equal(entry.visibility.type, 'private')
		assert.equal((entry.visibility as { owner: string }).owner, Owner)

		// The reference-only candidate must not have been touched: it is not the
		// attached command's own definition/declaration site.
		assert.equal(getImpDocSymbolData(referencedSymbol.data), undefined)
	})

	it('falls back to functionID without a global scan when the URI index has no candidates', () => {
		const definitionRange = { start: 100, end: 120 }
		const table = core.SymbolTable.link({
			objective: {
				'attached.synthetic_objective': {
					definition: [{ uri: Uri, range: definitionRange }],
				},
			},
		} as core.UnlinkedSymbolTable)
		const symbols = new core.SymbolUtil(table)
		// Deliberately do not build the URI reverse cache: this models an
		// unregistered client-managed / synthetic document.
		assert.deepEqual(symbols.getSymbolCandidatesAtUri(Uri), [])
		const definedSymbol = symbols.lookup('objective', ['attached.synthetic_objective']).symbol
		assert.ok(definedSymbol)

		const definitionCandidate: core.AstNode = {
			type: 'symbol',
			range: definitionRange,
			symbol: definedSymbol,
		}
		const doc: ImpDocNode = {
			type: 'impDoc',
			range: { start: 0, end: 130 },
			annotations: [annotation('@private')],
			contract: EmptyContract,
			functionID: value(Owner),
			children: [definitionCandidate],
			attachedNodes: [definitionCandidate],
			plainText: 'Synthetic attached objective doc',
			raw: '',
		}
		core.AstNode.setParents(doc)
		const ctx = {
			doc: { uri: Uri },
			err: new core.ErrorReporter(),
			symbols,
		} as unknown as core.BinderContext

		forbidGlobalSymbolScan(symbols)
		assert.doesNotThrow(() => stampAttachedSymbols(doc, ctx))

		const entry = getImpDocSymbolData(definedSymbol.data)?.declarations?.[0]
		assert.ok(entry)
		assert.equal(entry.owner, Owner)
		assert.equal(entry.visibility.type, 'private')
		assert.equal((entry.visibility as { owner: string }).owner, Owner)
	})

	it('is a no-op when the IMP-Doc component has no attached commands', () => {
		const symbols = new core.SymbolUtil(core.SymbolTable.link({} as core.UnlinkedSymbolTable))
		symbols.buildCache()
		forbidGlobalSymbolScan(symbols)

		const doc: ImpDocNode = {
			type: 'impDoc',
			range: { start: 0, end: 10 },
			annotations: [],
			contract: EmptyContract,
			functionID: value(Owner),
			children: [],
			plainText: '',
			raw: '',
		}
		const ctx = {
			doc: { uri: Uri },
			err: new core.ErrorReporter(),
			symbols,
		} as unknown as core.BinderContext

		assert.doesNotThrow(() => stampAttachedSymbols(doc, ctx))
	})
})
