import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServiceRuntime, type ServiceRuntime } from './contract-runtime.ts'

/**
 * P4-3b: checked-in `spyglass.json` の実 Language Server 経路 (Service
 * integration、 spike 5) での発火を pin する。 defaultConfig 側の lint は空にし、
 * `lint.impDocPrivate: "error"` が fixture project 直下の on-disk `spyglass.json`
 * から `ConfigService.load()` 経由で来ていることを保証する。 protocol (JSON-RPC)
 * 層は `server.ts` の素通し + `toLS` unit test 済みのため、 `documentErrored`
 * event (= `connection.sendDiagnostics` の発火元) までを検証する。
 */

type FileKey = 'helper' | 'caller'

describe('IMP-Doc checked-in spyglass.json runtime (P4-3b)', () => {
	let runtime: ServiceRuntime<FileKey> | undefined

	before(async () => {
		runtime = await createServiceRuntime({
			fixture: 'spyglass-json-project',
			files: {
				helper: 'data/owner/functions/helper.mcfunction',
				caller: 'data/external/functions/caller.mcfunction',
			},
			tempPrefix: 'spyglass-imp-doc-json-',
		})
	})

	after(async () => {
		await runtime?.close()
	})

	it('loads lint.impDocPrivate from the on-disk spyglass.json', () => {
		assert.ok(runtime)
		const lint = runtime.service.project.config.lint as unknown as Record<string, unknown>
		// factory の defaultConfig は lint を空にして `impDocContractCheck: off`
		// だけを持つ。 `impDocPrivate` が現れたら on-disk 由来と確定する。
		assert.equal(lint['impDocPrivate'], 'error')
		assert.equal(lint['impDocContractCheck'], 'off')
	})

	it('reports the private violation through the linter on the real Service path', () => {
		assert.ok(runtime)
		const caller = runtime.states.caller
		const errors = caller.node.linterErrors ?? []
		assert.equal(errors.length, 1)

		const targetStart = caller.content.lastIndexOf('owner:helper')
		assert.notEqual(targetStart, -1)
		assert.deepEqual(
			errors[0].range,
			core.Range.create(targetStart, targetStart + 'owner:helper'.length),
		)
		assert.match(errors[0].message, /impDocPrivate/)

		assert.deepEqual(runtime.states.helper.node.linterErrors ?? [], [])
	})

	it('publishes the violation via the documentErrored event consumed by the language server', async () => {
		assert.ok(runtime)
		const project = runtime.service.project
		const events: { errors: readonly unknown[]; uri: string }[] = []
		project.on('documentErrored', event => {
			events.push({ errors: event.errors, uri: event.uri })
		})

		// Re-check the open document; `server.ts` forwards this exact event to
		// `connection.sendDiagnostics`.
		await project.onDidChange(
			runtime.uris.caller,
			[{ text: runtime.states.caller.content }],
			2,
		)

		const published = events.filter(event => event.uri === runtime!.uris.caller)
		assert.ok(published.length > 0, 'expected documentErrored for the open document')
		const last = published[published.length - 1]
		assert.ok(
			last.errors.some(error => /impDocPrivate/.test((error as { message: string }).message)),
			'the impDocPrivate diagnostic must reach the publish payload',
		)
	})

	it('filters completion through Service.complete with the loaded config', () => {
		assert.ok(runtime)
		const caller = runtime.states.caller
		const offset = caller.content.lastIndexOf('owner:helper') + 'owner:helper'.length
		const items = runtime.service.complete(caller.node, caller.doc, offset)

		assert.ok(
			items.some(item => item.label === 'external:caller'),
			'public functions stay available',
		)
		assert.equal(
			items.filter(item => item.label === 'owner:helper').length,
			0,
			'the private target must not be completed for a denied caller',
		)
	})
})
