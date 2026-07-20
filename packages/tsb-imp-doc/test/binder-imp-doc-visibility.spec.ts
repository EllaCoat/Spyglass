import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { impDoc as bindImpDoc } from '../lib/binder/impDoc.js'
import { getImpDocSymbolData, impDoc as parseImpDoc, type ImpDocNode } from '../lib/index.js'

const Owner = 'owner:target'
const Uri = 'file:///data/owner/functions/target.mcfunction'

async function bindHeader(
	annotation?: string,
	headerID = Owner,
	symbolID = core.ResourceLocation.lengthen(headerID),
): Promise<{
	err: core.ErrorReporter
	node: ImpDocNode
	symbol: core.Symbol
}> {
	const content = `#> ${headerID}\n${
		annotation ? `# ${annotation}\n` : '# Header without annotations\n'
	}\n`
	const parseErrors = new core.ErrorReporter()
	const parsed = parseImpDoc(
		new core.Source(content),
		{ err: parseErrors } as Parameters<typeof parseImpDoc>[1],
	)
	assert.notEqual(parsed, core.Failure)
	assert.deepEqual(parseErrors.errors, [])
	const node = parsed as ImpDocNode
	core.AstNode.setParents(node)

	const table = core.SymbolTable.link({
		function: {
			[symbolID]: { definition: [{ uri: Uri }] },
		},
	} as core.UnlinkedSymbolTable)
	const symbols = new core.SymbolUtil(table)
	symbols.buildCache()
	const err = new core.ErrorReporter()
	await bindImpDoc(node, {
		doc: { uri: Uri },
		err,
		// Child dispatch always resolves a binder now (unregistered types fall
		// back); a sync no-op keeps this harness header-only.
		meta: { getBinder: () => () => {} },
		symbols,
	} as unknown as core.BinderContext)
	const symbol = symbols.lookup('function', [symbolID]).symbol
	assert.ok(symbol)
	return { err, node, symbol }
}

describe('IMP-Doc function binder visibility fallback', () => {
	it('preserves every valid visibility and the undocumented public default', async () => {
		for (
			const [label, annotation, expected] of [
				['private', '@private', { type: 'private', owner: Owner }],
				['internal', '@internal', { type: 'internal', owner: Owner }],
				[
					'within',
					'@within function owner:allowed',
					{
						type: 'within',
						owner: Owner,
						includeOwner: false,
						patterns: [{
							raw: 'owner:allowed',
							targetType: 'function',
							regex: '^owner:allowed$',
						}],
					},
				],
				['public', '@public', { type: 'public' }],
				['api', '@api', { type: 'public' }],
				['no annotation', undefined, { type: 'public' }],
			] as const
		) {
			const { err, node, symbol } = await bindHeader(annotation)
			assert.deepEqual(node.visibility, expected, label)
			assert.deepEqual(getImpDocSymbolData(symbol.data)?.visibility, expected, label)
			assert.deepEqual(err.errors, [], label)
		}
	})

	it('falls back to denied for malformed visibility annotations', async () => {
		for (
			const annotation of [
				'@within unknown_type allowed:path',
				'@within',
				'@within function tag1 tag2',
				'@public\n# @within unknown_type allowed:path',
			]
		) {
			const { err, node, symbol } = await bindHeader(annotation)
			assert.deepEqual(node.visibility, { type: 'denied', owner: Owner })
			assert.deepEqual(getImpDocSymbolData(symbol.data)?.visibility, {
				type: 'denied',
				owner: Owner,
			})
			assert.equal(symbol.visibility, 3)
			assert.ok(err.errors.some(error =>
				error.message.includes(
					'IMP-Doc visibility annotation is malformed; falling back to deny state',
				)
			))
		}
	})

	it('canonicalizes short and full default-namespace headers identically', async () => {
		for (const headerID of ['foo', 'minecraft:foo']) {
			const { err, node, symbol } = await bindHeader(
				'@private',
				headerID,
				'minecraft:foo',
			)
			assert.equal(node.functionID?.raw, headerID)
			assert.deepEqual(node.visibility, {
				type: 'private',
				owner: 'minecraft:foo',
			})
			assert.deepEqual(getImpDocSymbolData(symbol.data)?.visibility, {
				type: 'private',
				owner: 'minecraft:foo',
			})
			assert.equal(symbol.visibility, 3)
			assert.deepEqual(err.errors, [])
		}
	})

	it('stamps internal hover metadata and owner compatibility data', async () => {
		const { symbol } = await bindHeader('@internal')
		const data = getImpDocSymbolData(symbol.data)
		assert.equal(data?.privateOwner, Owner)
		assert.equal(data?.visibility?.type, 'internal')
		assert.match(symbol.desc ?? '', /Visibility:\*\* internal/)
		assert.deepEqual(symbol.visibilityRestriction, [
			'^owner:.{0,}$',
			'^minecraft:.{0,}$',
		])
	})
})
