import * as core from '@spyglassmc/core'
import type * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServiceRuntime, type ServiceRuntime } from './contract-runtime.ts'

const Commands: je.dependency.McmetaCommands = {
	type: 'root',
	children: {
		particle: {
			type: 'literal',
			children: {
				particle: {
					type: 'argument',
					parser: 'minecraft:particle',
					executable: true,
				},
			},
		},
	},
}

interface McdocEntityAttributeRegistration {
	readonly attribute: {
		readonly stringMocker?: (
			config: unknown,
			typeDef: unknown,
			ctx: core.CompleterContext,
		) => core.AstNode | undefined
	}
}

describe('IMP-Doc alias parser identity through Service (P4-3b)', () => {
	let runtime: ServiceRuntime<'aliases'> | undefined
	let syntheticCount = 0

	before(async () => {
		runtime = await createServiceRuntime({
			fixture: 'private-project',
			files: {
				aliases: 'data/owner/functions/aliases.mcfunction',
			},
			commands: Commands,
			tempPrefix: 'spyglass-imp-doc-alias-origin-',
		})
	})

	after(async () => {
		await runtime?.close()
	})

	async function completeMcfunction(contentWithCursor: string): Promise<core.CompletionItem[]> {
		assert.ok(runtime)
		const offset = contentWithCursor.indexOf('|')
		assert.notEqual(offset, -1)
		const content = contentWithCursor.replace('|', '')
		const uri = core.normalizeUri(
			new URL(
				`./runtime/private-project/data/owner/functions/alias_origin_${syntheticCount++}.mcfunction`,
				import.meta.url,
			).toString(),
		)
		await runtime.service.project.onDidOpen(uri, 'mcfunction', 1, content)
		const state = runtime.service.project.getClientManaged(uri)
		assert.ok(state)
		const items = runtime.service.complete(state.node, state.doc, offset)
		await runtime.service.project.onDidClose(uri)
		return items
	}

	it('does not offer vector aliases for the particle dust internal VectorNode mock', async () => {
		const items = await completeMcfunction('particle dust |')

		assert.ok(
			items.some(item => item.label === '~ ~ ~'),
			'particle dust should reach the base vector completer',
		)
		assert.equal(items.some(item => item.label === 'cached_vector'), false)
	})

	it('does not offer entity aliases for the registered MCDoc @entity mock', async () => {
		assert.ok(runtime)
		const meta = runtime.service.project.meta
		const registration = meta
			.getCustom<McdocEntityAttributeRegistration>('mcdoc:attribute')
			?.get('entity')
		assert.ok(registration?.attribute.stringMocker)

		// The carrier language invokes the real Java Edition @entity stringMocker in
		// the same order as mcdoc.runtime.completer, while keeping this regression
		// test on Service.complete without adding JSON/MCDoc package dependencies.
		meta.registerLanguage('test:mcdoc-entity', {
			extensions: ['.mcfunction'],
			parser: (src) => {
				const start = src.cursor
				src.skipRemaining()
				return {
					type: 'test:mcdoc-entity',
					range: core.Range.create(start, src.cursor),
					children: [],
				}
			},
			completer: (_node, ctx) => {
				const mock = registration.attribute.stringMocker?.(
					{ amount: 'multiple', type: 'entities' },
					{ kind: 'string' },
					ctx,
				)
				return mock ? ctx.meta.getCompleter(mock.type)(mock, ctx) : []
			},
		})

		const uri = core.normalizeUri(
			new URL(
				'./runtime/private-project/data/owner/functions/mcdoc_entity_mock.mcfunction',
				import.meta.url,
			).toString(),
		)
		await runtime.service.project.onDidOpen(uri, 'test:mcdoc-entity', 1, '')
		const state = runtime.service.project.getClientManaged(uri)
		assert.ok(state)
		const items = runtime.service.complete(state.node, state.doc, 0)
		await runtime.service.project.onDidClose(uri)

		assert.ok(
			items.some(item => item.label.startsWith('@')),
			'MCDoc @entity should retain base selector completions',
		)
		assert.equal(items.some(item => item.label === 'cached_entity'), false)
	})
})
