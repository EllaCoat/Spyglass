import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ImpDocRefProvenance } from '../lib/index.js'
import { legacyGlobToRegex, setRefProvenance, stampVisibility } from '../lib/index.js'
import { privateVisibility } from '../lib/linter/private.js'
import { privateBestEffortVisibility } from '../lib/linter/privateBestEffort.js'

const CallerUri = 'file:///data/example/functions/caller.mcfunction'
const TargetUri = 'file:///data/example/functions/private.mcfunction'
const DeclarationUri = 'file:///data/example/functions/_index.d.mcfunction'

function refNode(
	id: string,
	provenance?: ImpDocRefProvenance,
	isTag = false,
): core.ResourceLocationNode {
	const separator = id.indexOf(':')
	const node: core.ResourceLocationNode = {
		type: 'resource_location',
		range: { start: 0, end: id.length },
		namespace: id.slice(0, separator),
		path: id.slice(separator + 1).split('/'),
		isTag,
		options: { category: 'function', allowTag: true, usageType: 'reference' },
	}
	if (provenance) {
		setRefProvenance(node, provenance)
	}
	return node
}

function fileNode(...children: core.AstNode[]): core.AstNode {
	return { type: 'file', range: { start: 0, end: 0 }, children }
}

interface Harness {
	symbols: core.SymbolUtil
	/** The `example:private` symbol (restricted symbols hide from plain queries). */
	target: core.Symbol
	lint: (
		linter: core.Linter<core.AstNode>,
		node: core.AstNode,
	) => readonly core.LanguageError[]
}

/**
 * Minimal double for the runner's lint pass: the private linters only touch
 * `ctx.symbols`, `ctx.doc.uri`, and `ctx.err`, so no full ProjectData is
 * required. The caller function is registered as defined at `CallerUri` and
 * the private target as defined at `TargetUri` with an `@private` stamp.
 */
function createHarness(): Harness {
	const symbols = new core.SymbolUtil({})
	let target: core.Symbol | undefined
	symbols.contributeAs('uri_binder', () => {
		symbols.query(CallerUri, 'function', 'example:caller').enter({
			usage: { type: 'definition' },
		})
		const query = symbols.query(TargetUri, 'function', 'example:private')
		query.enter({ usage: { type: 'definition' } })
		target = query.symbol!
		stampVisibility(target, { type: 'private', owner: 'example:private' })
	})
	return {
		symbols,
		target: target!,
		lint: (linter, node) => {
			const err = new core.LinterErrorReporter(
				'test-rule',
				core.ErrorSeverity.Warning,
			)
			const ctx = {
				symbols,
				doc: { uri: CallerUri },
				err,
			} as unknown as core.LinterContext
			linter(core.StateProxy.create(node), ctx)
			return err.dump()
		},
	}
}

function enterReference(
	symbols: core.SymbolUtil,
	id: string,
	node: core.ResourceLocationNode,
): void {
	symbols.contributeAs('binder', () => {
		symbols.query(CallerUri, 'function', id).enter({
			usage: { type: 'reference', node },
		})
	})
}

describe('impDocPrivate vs impDocPrivateBestEffort provenance split', () => {
	it('impDocPrivate reports untagged references and skips provenance-tagged ones', () => {
		const harness = createHarness()
		const untagged = refNode('example:private')
		const tagged = refNode('example:private', 'macro')
		enterReference(harness.symbols, 'example:private', untagged)
		enterReference(harness.symbols, 'example:private', tagged)

		const errors = harness.lint(privateVisibility, fileNode(untagged, tagged))
		assert.equal(errors.length, 1)
		assert.equal(core.Range.equals(errors[0].range, untagged.range), true)
		assert.equal(errors[0].message.includes('is private to “example:private”'), true)
	})

	it('impDocPrivateBestEffort reports only provenance-tagged references', () => {
		const harness = createHarness()
		const untagged = refNode('example:private')
		const macroRef = refNode('example:private', 'macro')
		const quotedRef = refNode('example:private', 'nbt-string')
		enterReference(harness.symbols, 'example:private', untagged)
		enterReference(harness.symbols, 'example:private', macroRef)
		enterReference(harness.symbols, 'example:private', quotedRef)

		const errors = harness.lint(
			privateBestEffortVisibility,
			fileNode(untagged, macroRef, quotedRef),
		)
		assert.equal(errors.length, 2)
		assert.equal(errors[0].message.includes('(referenced in a macro line)'), true)
		assert.equal(errors[1].message.includes('(referenced in a quoted string)'), true)
		for (const error of errors) {
			assert.equal(
				error.message.includes(
					'is private to “example:private” and cannot be called from “example:caller”',
				),
				true,
			)
		}
	})

	it('impDocPrivateBestEffort flags tagged references without any declaration', () => {
		const harness = createHarness()
		const missing = refNode('example:missing', 'macro')
		enterReference(harness.symbols, 'example:missing', missing)

		const errors = harness.lint(privateBestEffortVisibility, fileNode(missing))
		assert.equal(errors.length, 1)
		assert.equal(
			errors[0].message.includes(
				'“example:missing” is referenced in a macro line but is not declared anywhere',
			),
			true,
		)
	})

	it('impDocPrivateBestEffort exempts tag references from the existence check', () => {
		const harness = createHarness()
		const tagRef = refNode('example:some_tag', 'macro', true)

		const errors = harness.lint(privateBestEffortVisibility, fileNode(tagRef))
		assert.deepEqual(errors, [])
	})

	it('impDocPrivateBestEffort honours the v3 visibility union (any-match admits the caller)', () => {
		const harness = createHarness()
		// A caller-local declaration union entry admits `example:caller` even
		// though the definition-side entry stays `@private`.
		stampVisibility(harness.target, {
			type: 'within',
			owner: 'example:private',
			includeOwner: false,
			patterns: [{
				raw: 'example:caller',
				targetType: '*',
				regex: legacyGlobToRegex('example:caller'),
			}],
		}, {
			uri: DeclarationUri,
			range: { start: 0, end: 1 },
			owner: 'example:private',
		})
		const tagged = refNode('example:private', 'macro')
		enterReference(harness.symbols, 'example:private', tagged)

		const errors = harness.lint(privateBestEffortVisibility, fileNode(tagged))
		assert.deepEqual(errors, [])
	})
})
