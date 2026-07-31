import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { getImpDocSymbolData } from '../lib/index.js'
import { createServiceRuntime, type ServiceRuntime } from './contract-runtime.ts'

/**
 * End-to-end cover for the bare `#declare` parity fix. Everything below runs on
 * the real `core.Service` path (parse → `mcfunction:entry` binder → comment
 * fallback binder → `impDoc:declaration` binder → core lint), so a break
 * anywhere in that dispatch chain surfaces here rather than in a unit test that
 * calls the binder itself.
 *
 * `bare:target` is declared by a directive that owns no IMP-Doc block, in a
 * different document than the one referencing it; `bare:missing` is declared
 * nowhere and keeps the `undeclaredSymbol` rule demonstrably live.
 */
describe('bare IMP-Doc declaration runtime', () => {
	type FileKey = 'index' | 'caller'
	let runtime: ServiceRuntime<FileKey> | undefined

	function createConfig(): core.Config {
		const config = core.ConfigService.merge(core.VanillaConfig, {
			env: { dependencies: [], exclude: [], gameVersion: '1.20.4' },
		})
		const lint = config.lint as unknown as Record<string, unknown>
		for (const name of Object.keys(lint)) {
			delete lint[name]
		}
		lint['undeclaredSymbol'] = [
			{ if: { category: ['function'] }, then: { report: 'error' } },
			{ then: { declare: 'block' } },
		]
		return config
	}

	before(async () => {
		runtime = await createServiceRuntime({
			fixture: 'bare-declaration-project',
			files: {
				index: 'data/bare/functions/_index.d.mcfunction',
				caller: 'data/other/functions/caller.mcfunction',
			},
			defaultConfig: createConfig(),
			tempPrefix: 'spyglass-imp-doc-bare-runtime-',
		})
	})

	after(async () => {
		await runtime?.close()
	})

	it('reports undeclared functions but not the bare-declared one', () => {
		assert.ok(runtime)
		const caller = runtime.states.caller
		const errors = caller.node.linterErrors ?? []

		// The rule must stay live: `bare:missing` is the negative control, so an
		// empty result here would mean the assertion below proves nothing.
		assert.deepEqual(
			errors.map(error => [
				caller.content.slice(error.range.start, error.range.end),
				error.message,
			]),
			[['bare:missing', 'Cannot find function “bare:missing” (rule: undeclaredSymbol)']],
		)
	})

	it('declares the bare directive symbol from the declaring document', () => {
		assert.ok(runtime)
		const symbol = runtime.service.project.symbols.lookup('function', ['bare:target']).symbol
		assert.ok(symbol)
		assert.deepEqual(
			symbol.declaration?.map(location => location.uri),
			[runtime.uris.index],
		)
		// v3 registered a bare directive with `env.defaultVisibility`; the
		// header's `@within function bare:**` must not have narrowed it.
		assert.deepEqual(
			getImpDocSymbolData(symbol.data)?.declarations?.map(entry => entry.visibility),
			[{ type: 'public' }],
		)
	})
})
