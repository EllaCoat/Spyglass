import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ImpDocVisibility, WithinTargetType } from '../lib/index.js'
import { legacyGlobToRegex, stampVisibility } from '../lib/index.js'
import { privateVisibility } from '../lib/linter/private.js'

const FunctionCallerUri = 'file:///data/example/functions/caller.mcfunction'
const BiomeCallerUri = 'file:///data/example/worldgen/biome/caller.json'
const TargetUri = 'file:///data/example/functions/target.mcfunction'

function refNode(
	category: string,
	id: string,
	isTag = false,
): core.ResourceLocationNode {
	const separator = id.indexOf(':')
	// `worldgen/configured_decorator` is a legacy-only category outside core's
	// typed category union, so the options literal needs a cast.
	return {
		type: 'resource_location',
		range: { start: 0, end: id.length },
		namespace: id.slice(0, separator),
		path: id.slice(separator + 1).split('/'),
		isTag,
		options: { category, allowTag: true, usageType: 'reference' },
	} as unknown as core.ResourceLocationNode
}

function symbolNode(category: string, value: string): core.SymbolNode {
	return {
		type: 'symbol',
		range: { start: 0, end: value.length },
		value,
		options: { category, usageType: 'reference' },
	}
}

function fileNode(...children: core.AstNode[]): core.AstNode {
	return { type: 'file', range: { start: 0, end: 0 }, children }
}

function withinVisibility(
	owner: string,
	targetType: WithinTargetType,
	pattern: string,
): ImpDocVisibility {
	return {
		type: 'within',
		owner,
		includeOwner: false,
		patterns: [{
			raw: pattern,
			targetType,
			regex: legacyGlobToRegex(pattern),
		}],
	}
}

interface Harness {
	symbols: core.SymbolUtil
	enterCaller: (
		category: string,
		id: string,
		uri: string,
		usage?: core.SymbolUsageType,
	) => void
	/** Enters a restricted target symbol and returns it for stamping. */
	enterTarget: (category: string, id: string) => core.Symbol
	enterReference: (
		category: string,
		id: string,
		node: core.AstNode,
		uri: string,
	) => void
	lint: (node: core.AstNode, uri: string) => readonly core.LanguageError[]
}

/**
 * Minimal double for the runner's lint pass, mirroring the best-effort spec
 * harness: the private linter only touches `ctx.symbols`, `ctx.doc.uri`, and
 * `ctx.err`. Callers are registered per test so both function and non-function
 * (JSON / worldgen) caller documents can be characterized.
 */
function createHarness(): Harness {
	const symbols = new core.SymbolUtil({})
	return {
		symbols,
		enterCaller: (category, id, uri, usage = 'definition') => {
			symbols.contributeAs('uri_binder', () => {
				symbols.query(uri, category, id).enter({ usage: { type: usage } })
			})
		},
		enterTarget: (category, id) => {
			let target: core.Symbol | undefined
			symbols.contributeAs('uri_binder', () => {
				const query = symbols.query(TargetUri, category, id)
				query.enter({ usage: { type: 'declaration' } })
				target = query.symbol!
			})
			return target!
		},
		enterReference: (category, id, node, uri) => {
			symbols.contributeAs('binder', () => {
				symbols.query(uri, category, id).enter({
					usage: { type: 'reference', node },
				})
			})
		},
		lint: (node, uri) => {
			const err = new core.LinterErrorReporter(
				'test-rule',
				core.ErrorSeverity.Error,
			)
			const ctx = {
				symbols,
				doc: { uri },
				err,
			} as unknown as core.LinterContext
			privateVisibility(core.StateProxy.create(node), ctx)
			return err.dump()
		},
	}
}

describe('impDocPrivate generic caller and category coverage', () => {
	it('keeps the function-to-function message and honours allowed callers', () => {
		const harness = createHarness()
		harness.enterCaller('function', 'example:caller', FunctionCallerUri)
		const target = harness.enterTarget('function', 'example:private')
		stampVisibility(target, { type: 'private', owner: 'example:private' })
		const denied = refNode('function', 'example:private')
		harness.enterReference('function', 'example:private', denied, FunctionCallerUri)

		const errors = harness.lint(fileNode(denied), FunctionCallerUri)
		assert.equal(errors.length, 1)
		assert.equal(
			errors[0].message.includes(
				'Function “example:private” is private to “example:private” and cannot be called from “example:caller”',
			),
			true,
		)

		// The same reference from the owner document itself stays allowed.
		const ownerUri = 'file:///data/example/functions/private.mcfunction'
		harness.enterCaller('function', 'example:private', ownerUri)
		const allowed = refNode('function', 'example:private')
		harness.enterReference('function', 'example:private', allowed, ownerUri)
		assert.deepEqual(harness.lint(fileNode(allowed), ownerUri), [])
	})

	it('applies visibility metadata to tag/function references', () => {
		const harness = createHarness()
		harness.enterCaller('function', 'example:caller', FunctionCallerUri)
		harness.enterCaller(
			'function',
			'allowed:caller',
			'file:///data/allowed/functions/caller.mcfunction',
		)
		const target = harness.enterTarget('tag/function', 'example:some_tag')
		stampVisibility(target, withinVisibility('example:owner', 'function', 'allowed:**'))

		const denied = refNode('function', 'example:some_tag', true)
		harness.enterReference('tag/function', 'example:some_tag', denied, FunctionCallerUri)
		const errors = harness.lint(fileNode(denied), FunctionCallerUri)
		assert.equal(errors.length, 1)
		assert.equal(
			errors[0].message.includes(
				'Symbol “example:some_tag” in category “tag/function” is restricted by “example:owner” and cannot be referenced from “example:caller”',
			),
			true,
		)

		const allowedUri = 'file:///data/allowed/functions/caller.mcfunction'
		const allowed = refNode('function', 'example:some_tag', true)
		harness.enterReference('tag/function', 'example:some_tag', allowed, allowedUri)
		assert.deepEqual(harness.lint(fileNode(allowed), allowedUri), [])
	})

	it('resolves JSON worldgen callers and matches @within by caller file type', () => {
		const harness = createHarness()
		// The caller document is a worldgen JSON resource, not a function.
		harness.enterCaller('worldgen/biome', 'example:caller_biome', BiomeCallerUri)
		const target = harness.enterTarget(
			'worldgen/configured_decorator',
			'example:deco',
		)
		stampVisibility(
			target,
			withinVisibility('example:owner', 'worldgen/biome', 'example:**'),
		)

		const allowed = refNode('worldgen/configured_decorator', 'example:deco')
		harness.enterReference(
			'worldgen/configured_decorator',
			'example:deco',
			allowed,
			BiomeCallerUri,
		)
		assert.deepEqual(harness.lint(fileNode(allowed), BiomeCallerUri), [])

		// A pattern restricted to function callers denies the worldgen caller
		// even though the resource ID itself matches.
		stampVisibility(
			target,
			withinVisibility('example:owner', 'function', 'example:**'),
		)
		const denied = refNode('worldgen/configured_decorator', 'example:deco')
		harness.enterReference(
			'worldgen/configured_decorator',
			'example:deco',
			denied,
			BiomeCallerUri,
		)
		const errors = harness.lint(fileNode(denied), BiomeCallerUri)
		assert.equal(errors.length, 1)
		assert.equal(
			errors[0].message.includes(
				'Symbol “example:deco” in category “worldgen/configured_decorator” is restricted by “example:owner” and cannot be referenced from “example:caller_biome”',
			),
			true,
		)
	})

	it('lints plain-variable symbol nodes against @private declarations', () => {
		const harness = createHarness()
		harness.enterCaller('function', 'example:caller', FunctionCallerUri)
		const target = harness.enterTarget('objective', 'Obj.One')
		stampVisibility(target, { type: 'private', owner: 'example:owner' })
		const denied = symbolNode('objective', 'Obj.One')
		harness.enterReference('objective', 'Obj.One', denied, FunctionCallerUri)

		const errors = harness.lint(fileNode(denied), FunctionCallerUri)
		assert.equal(errors.length, 1)
		assert.equal(
			errors[0].message.includes(
				'Symbol “Obj.One” in category “objective” is private to “example:owner” and cannot be referenced from “example:caller”',
			),
			true,
		)
	})

	it('keeps usageType-less option nodes on the constant-time reference fast path', () => {
		const harness = createHarness()
		harness.enterCaller('function', 'example:caller', FunctionCallerUri)
		const target = harness.enterTarget('function', 'example:private')
		stampVisibility(target, { type: 'private', owner: 'example:private' })

		const references = Array.from({ length: 64 }, (_, index) => {
			const node = refNode('function', 'example:private')
			const start = index * 32
			node.range = { start, end: start + 'example:private'.length }
			delete node.options.usageType
			harness.enterReference('function', 'example:private', node, FunctionCallerUri)
			return node
		})

		const locations = target.reference
		let referenceReads = 0
		Object.defineProperty(target, 'reference', {
			configurable: true,
			get: () => {
				referenceReads += 1
				return locations
			},
		})

		assert.equal(harness.lint(fileNode(...references), FunctionCallerUri).length, 64)
		assert.equal(
			referenceReads,
			0,
			'options-bearing nodes must not read the shared symbol.reference array',
		)
	})

	it('uses exact symbol reference locations for metadata-free nodes', () => {
		const harness = createHarness()
		harness.enterCaller('function', 'example:caller', FunctionCallerUri)
		const target = harness.enterTarget('objective', 'Obj.One')
		stampVisibility(target, { type: 'private', owner: 'example:owner' })
		const reference: core.AstNode = {
			type: 'legacy:reference',
			range: { start: 20, end: 27 },
		}
		harness.enterReference('objective', 'Obj.One', reference, FunctionCallerUri)

		const errors = harness.lint(fileNode(reference), FunctionCallerUri)
		assert.equal(errors.length, 1)
		assert.equal(errors[0].range.start, reference.range.start)
	})

	it('never lints declaration or definition sites', () => {
		const harness = createHarness()
		harness.enterCaller('function', 'example:caller', FunctionCallerUri)
		const target = harness.enterTarget('objective', 'Obj.One')
		stampVisibility(target, { type: 'private', owner: 'example:owner' })

		// A bound node without usage options and without a matching reference
		// location models a declaration site (e.g. `#declare`).
		const declarationSite: core.AstNode = {
			type: 'impDoc:declaration',
			range: { start: 5, end: 12 },
		}
		harness.symbols.contributeAs('binder', () => {
			harness.symbols
				.query(FunctionCallerUri, 'objective', 'Obj.One')
				.enter({ usage: { type: 'declaration', node: declarationSite } })
		})
		assert.deepEqual(
			harness.lint(fileNode(declarationSite), FunctionCallerUri),
			[],
		)
	})

	it('fails closed when a non-function caller document is ambiguous', () => {
		const harness = createHarness()
		// Two distinct biome resources claim the same caller document.
		harness.enterCaller('worldgen/biome', 'example:first', BiomeCallerUri)
		harness.enterCaller('worldgen/biome', 'example:second', BiomeCallerUri)
		const target = harness.enterTarget('worldgen/configured_decorator', 'example:deco')
		stampVisibility(target, { type: 'private', owner: 'example:owner' })
		const ref = refNode('worldgen/configured_decorator', 'example:deco')
		harness.enterReference(
			'worldgen/configured_decorator',
			'example:deco',
			ref,
			BiomeCallerUri,
		)

		// No caller resolves, so the strict rule reports nothing instead of
		// guessing between the two candidate resources.
		assert.deepEqual(harness.lint(fileNode(ref), BiomeCallerUri), [])
	})
})
