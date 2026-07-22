import * as core from '@spyglassmc/core'
import type * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { LegacyCategorySpec } from '../lib/index.js'
import { LEGACY_ALIAS_TYPES, LEGACY_DECLARABLE_TYPES } from '../lib/index.js'
import { createServiceRuntime, type ServiceRuntime } from './contract-runtime.ts'

const PublicDesc = '55+3 consumer matrix public declarations (Phase 4-3c freeze)'

/**
 * Manifest-driven naming, kept in lock-step with
 * `test/runtime/matrix-project/data/matrix/functions/_index.d.mcfunction`
 * (generated from this same `LEGACY_DECLARABLE_TYPES` manifest at fixture
 * authoring time -- Phase 4-3c freeze, regenerate both together).
 */
function slug(id: string): string {
	return id.replace(/\//g, '_')
}

function isTagCategory(id: string): boolean {
	return id.startsWith('tag/')
}

function literalFor(spec: LegacyCategorySpec): string {
	return `matrix_${slug(spec.id)}`
}

function declaredName(spec: LegacyCategorySpec, variant: 'public' | 'restricted'): string {
	const name = `${slug(spec.id)}_${variant}`
	return spec.consumerKind === 'resource-location' ? `matrix:${name}` : name
}

function registryFor(spec: LegacyCategorySpec): string {
	const canonical = spec.v4Category ?? spec.id
	return isTagCategory(spec.id) ? canonical.slice('tag/'.length) : canonical
}

function refTextFor(spec: LegacyCategorySpec, name: string): string {
	return spec.consumerKind === 'resource-location' && isTagCategory(spec.id) ? `#${name}` : name
}

/** Fixed permutation: reproducible while exercising cross-cell state in non-manifest order. */
function permutedDeclarableTypes(): LegacyCategorySpec[] {
	const result = [...LEGACY_DECLARABLE_TYPES]
	let seed = 0x43c
	for (let i = result.length - 1; i > 0; i--) {
		seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
		const j = seed % (i + 1)
		;[result[i], result[j]] = [result[j]!, result[i]!]
	}
	return result
}

function symbolParserFor(id: string): string {
	if (id === 'tag') {
		return 'spyglassmc:tag'
	}
	if (id === 'team') {
		return 'minecraft:team'
	}
	return 'minecraft:objective'
}

/**
 * Dynamically generates one probe command per declarable category (Plan
 * Focus 4): namespaced categories go through `minecraft:resource_key` /
 * `minecraft:resource_or_tag_key` with `properties.registry` (the same
 * registry pass-through `java-edition/src/mcfunction/parser/argument.ts:250-263`
 * uses for real vanilla commands), while the 5 non-resource-location
 * categories (`objective`/`tag`/`team`/`score_holder`/`entity`) get their own
 * real argument parser. Two extra probes provide 0-length trigger contexts
 * for the `vector` / `uuid` alias completion cells.
 */
function matrixCommands(): je.dependency.McmetaCommands {
	const children: Record<string, unknown> = {}
	for (const spec of LEGACY_DECLARABLE_TYPES) {
		const literal = literalFor(spec)
		switch (spec.consumerKind) {
			case 'resource-location':
				children[literal] = {
					type: 'literal',
					children: {
						ref: {
							type: 'argument',
							parser: isTagCategory(spec.id)
								? 'minecraft:resource_or_tag_key'
								: 'minecraft:resource_key',
							properties: { registry: `minecraft:${registryFor(spec)}` },
							executable: true,
						},
					},
				}
				break
			case 'symbol':
				children[literal] = {
					type: 'literal',
					children: {
						ref: { type: 'argument', parser: symbolParserFor(spec.id), executable: true },
					},
				}
				break
			case 'score-holder':
				children[literal] = {
					type: 'literal',
					children: {
						ref: {
							type: 'argument',
							parser: 'minecraft:score_holder',
							properties: { amount: 'single' },
							executable: true,
						},
					},
				}
				break
			case 'entity':
				children[literal] = {
					type: 'literal',
					children: {
						ref: {
							type: 'argument',
							parser: 'minecraft:entity',
							properties: { amount: 'multiple', type: 'entities' },
							executable: true,
						},
					},
				}
				break
				// `alias` is handled by `LEGACY_ALIAS_TYPES` below, not a declarable spec.
		}
	}
	children['matrix_alias_vector_probe'] = {
		type: 'literal',
		children: { ref: { type: 'argument', parser: 'minecraft:vec3', executable: true } },
	}
	children['matrix_alias_uuid_probe'] = {
		type: 'literal',
		children: { ref: { type: 'argument', parser: 'minecraft:uuid', executable: true } },
	}
	return { type: 'root', children } as je.dependency.McmetaCommands
}

function matrixConfig(): core.Config {
	const config = core.ConfigService.merge(core.VanillaConfig, {
		env: { dependencies: [], exclude: [], gameVersion: '1.20.4' },
	})
	const lint = config.lint as unknown as Record<string, unknown>
	for (const rule of Object.keys(lint)) {
		delete lint[rule]
	}
	lint['impDocPrivate'] = 'error'
	return config
}

describe('55+3 consumer matrix (P4-3c freeze)', () => {
	let runtime: ServiceRuntime<'index' | 'allowed' | 'denied'> | undefined
	let changeVersion = 1
	let syntheticCount = 0

	before(async () => {
		runtime = await createServiceRuntime({
			fixture: 'matrix-project',
			files: {
				index: 'data/matrix/functions/_index.d.mcfunction',
				// `allowed` matches the `@within function matrix:allowed/**` restricted
				// declarations; `denied` does not. Both are watched (not purely
				// synthetic) so java-edition's `uriBinder` registers their own
				// `function` identity -- an ad-hoc `onDidOpen`-only URI never gets that
				// registration, which silently breaks `getDocumentResource()` caller
				// resolution (completion filtering + `impDocPrivate` both need it).
				// Their content is rewritten per matrix cell via `onDidChange`.
				allowed: 'data/matrix/functions/allowed/consumer.mcfunction',
				denied: 'data/matrix/functions/denied/consumer.mcfunction',
			},
			commands: matrixCommands(),
			defaultConfig: matrixConfig(),
			tempPrefix: 'spyglass-imp-doc-matrix-',
		})
	})

	after(async () => {
		await runtime?.close()
	})

	async function setCallerContent(
		caller: 'allowed' | 'denied',
		content: string,
	): Promise<core.DocAndNode> {
		assert.ok(runtime)
		const uri = runtime.uris[caller]
		changeVersion += 1
		await runtime.service.project.onDidChange(uri, [{ text: content }], changeVersion)
		const state = runtime.service.project.getClientManaged(uri)
		assert.ok(state, `${uri} should still be client-managed after the edit`)
		return state
	}

	/** Opens a synthetic on-disk-free probe file (Plan Focus 4: synthetic onDidOpen). */
	async function openProbe(
		label: string,
		content: string,
	): Promise<{ uri: string; state: core.DocAndNode }> {
		assert.ok(runtime)
		const uri = core.normalizeUri(
			new URL(
				`./runtime/matrix-project/data/matrix/functions/allowed/${label}_${syntheticCount++}.mcfunction`,
				import.meta.url,
			).toString(),
		)
		await runtime.service.project.onDidOpen(uri, 'mcfunction', 1, content)
		const state = runtime.service.project.getClientManaged(uri)
		assert.ok(state, `${uri} should have bound`)
		return { uri, state }
	}

	async function closeProbe(uri: string): Promise<void> {
		assert.ok(runtime)
		await runtime.service.project.onDidClose(uri)
	}

	/**
	 * Alias completion (below) does not need caller resolution (`completer/alias.ts`
	 * has no visibility gating), so it keeps using disposable synthetic files.
	 */
	async function completeAt(
		label: string,
		contentWithCursor: string,
	): Promise<core.CompletionItem[]> {
		assert.ok(runtime)
		const offset = contentWithCursor.indexOf('|')
		assert.notEqual(offset, -1)
		const { uri, state } = await openProbe(label, contentWithCursor.replace('|', ''))
		const items = runtime.service.complete(state.node, state.doc, offset)
		await closeProbe(uri)
		return items
	}

	it('accounts for exactly 290 cells', () => {
		const requiredCells = LEGACY_DECLARABLE_TYPES.length * 5
		const aliasCompletionCells = LEGACY_ALIAS_TYPES.length
		const naCells = LEGACY_ALIAS_TYPES.length * 4
		assert.equal(requiredCells, 275)
		assert.equal(aliasCompletionCells, 3)
		assert.equal(naCells, 12)
		assert.equal(requiredCells + aliasCompletionCells + naCells, 290)
	})

	it('accounts for the 12 alias N/A cells with a reason', () => {
		const naReason = 'expanded source retains no alias identity'
		const naCells = LEGACY_ALIAS_TYPES.flatMap(spec =>
			(['hover', 'definition', 'reference', 'diagnostics'] as const).map(consumer => ({
				kind: 'na' as const,
				alias: spec.id,
				consumer,
				reason: naReason,
			}))
		)
		assert.equal(naCells.length, 12)
		assert.ok(naCells.every(cell => cell.reason === naReason))
	})

	for (const spec of permutedDeclarableTypes()) {
		const literal = literalFor(spec)
		const publicName = declaredName(spec, 'public')
		const restrictedName = declaredName(spec, 'restricted')
		const publicRef = refTextFor(spec, publicName)
		const restrictedRef = refTextFor(spec, restrictedName)
		// `entity` keeps v3's soft navigation semantics: `linter/private.ts` skips
		// strict visibility lint for this plugin-local category on purpose, so the
		// diagnostics cell asserts the *absence* of a violation as its passing state.
		const diagnosticsMode: 'error' | 'soft-none' = spec.id === 'entity' ? 'soft-none' : 'error'

		describe(spec.id, () => {
			it('completion', async () => {
				const allowedState = await setCallerContent('allowed', `${literal} `)
				const allowedItems = runtime!.service.complete(
					allowedState.node,
					allowedState.doc,
					`${literal} `.length,
				)
				assert.ok(
					allowedItems.some(item => item.label.endsWith(publicName)),
					`allowed caller should see ${publicName}`,
				)
				assert.ok(
					allowedItems.some(item => item.label.endsWith(restrictedName)),
					`allowed caller should see ${restrictedName} (matches @within)`,
				)

				const deniedState = await setCallerContent('denied', `${literal} `)
				const deniedItems = runtime!.service.complete(
					deniedState.node,
					deniedState.doc,
					`${literal} `.length,
				)
				assert.ok(
					deniedItems.some(item => item.label.endsWith(publicName)),
					`denied caller should still see public ${publicName}`,
				)
				assert.equal(
					deniedItems.some(item => item.label.endsWith(restrictedName)),
					false,
					`denied caller must not see restricted ${restrictedName}`,
				)
			})

			it('hover', async () => {
				const content = `${literal} ${publicRef}`
				const offset = literal.length + 1
				const state = await setCallerContent('allowed', content)
				const hover = runtime!.service.getHover(state.node, state.doc, offset)
				assert.ok(hover, `hover should resolve for ${publicName}`)
				assert.ok(hover.markdown.includes(publicName))
				assert.ok(hover.markdown.includes(PublicDesc))
			})

			it('definition', async () => {
				const content = `${literal} ${publicRef}`
				const offset = literal.length + 1
				const state = await setCallerContent('allowed', content)
				const locations = await runtime!.service.getSymbolLocations(
					state.node,
					state.doc,
					offset,
					['declaration', 'definition'],
				)
				assert.ok(locations?.locations?.length, `definition should resolve for ${publicName}`)
				assert.ok(
					locations!.locations!.some(loc => loc.uri === runtime!.uris.index),
					'definition must point back to _index.d.mcfunction',
				)
			})

			it('reference', async () => {
				const marker = `# reference cell: ${spec.id}\n`
				const content = `${marker}${literal} ${publicRef}`
				await setCallerContent('allowed', content)
				const expectedRange = {
					start: marker.length + literal.length + 1,
					end: content.length,
				}
				const indexState = runtime!.states.index
				const declarationOffset = indexState.content.indexOf(publicName)
				assert.notEqual(declarationOffset, -1)
				const refUri = runtime!.uris.allowed
				const locations = await runtime!.service.getSymbolLocations(
					indexState.node,
					indexState.doc,
					declarationOffset + 1,
					['reference'],
				)
				assert.ok(locations?.locations?.length, `reference should resolve for ${publicName}`)
				assert.deepEqual(
					locations!.locations!
						.filter(loc => loc.uri === refUri)
						.map(loc => loc.range),
					[expectedRange],
					'reference must match this cell marker and carrier range exactly',
				)
			})

			it('diagnostics', async () => {
				const content = `${literal} ${restrictedRef}`
				const state = await setCallerContent('denied', content)
				const errors = state.node.linterErrors ?? []
				if (diagnosticsMode === 'soft-none') {
					assert.deepEqual(errors, [], `${spec.id} keeps v3 soft navigation (no strict lint)`)
				} else {
					assert.equal(errors.length, 1, `denied caller must be flagged for ${restrictedName}`)
					assert.match(errors[0]!.message, /impDocPrivate/)
				}
			})
		})
	}

	// Alias completion cells are re-verified inline here (freeze principle: pin
	// once). Each kind needs its own 0-length trigger context (Plan Focus 4 /
	// `completer/alias.ts`): `minecraft:entity` selector mock for `entity`, a
	// `minecraft:vec3` argument for `vector`, and `minecraft:uuid` for `uuid`.
	describe('alias completion (3 required cells)', () => {
		it('completes alias/vector at a vec3 argument', async () => {
			const items = await completeAt('alias-vector', 'matrix_alias_vector_probe |')
			assert.ok(items.some(item => item.label === 'matrix_alias_vector'))
		})

		it('completes alias/entity at an entity selector argument', async () => {
			const items = await completeAt('alias-entity', 'matrix_entity |')
			assert.ok(items.some(item => item.label === 'matrix_alias_entity'))
		})

		it('completes alias/uuid at a uuid argument', async () => {
			const items = await completeAt('alias-uuid', 'matrix_alias_uuid_probe |')
			assert.ok(items.some(item => item.label === 'matrix_alias_uuid'))
		})
	})
})
