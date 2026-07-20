import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { main } from '../lib/index.js'

/**
 * Pins the CLI exit-code contract: violations (errors) fail the run, warnings
 * only fail it under `--strict`. The warning fixture relies on the
 * impDocPrivateBestEffort default severity.
 */
describe('CLI exit codes', () => {
	let errorDir: string
	let warningDir: string

	async function writeFixture(
		dir: string,
		files: Record<string, string>,
	): Promise<void> {
		const functionsDir = join(dir, 'data', 'example', 'functions')
		await mkdir(functionsDir, { recursive: true })
		await Promise.all(
			Object.entries(files).map(([name, content]) =>
				writeFile(join(functionsDir, name), content)
			),
		)
	}

	beforeEach(async () => {
		errorDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-exit-error-'))
		warningDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-exit-warn-'))
		await Promise.all([
			writeFixture(errorDir, {
				'private.mcfunction': '#> example:private\n# @private\n\nsay private\n',
				'caller.mcfunction': '#> example:caller\n\nfunction example:private\n',
			}),
			writeFixture(warningDir, {
				'macro_caller.mcfunction': '#> example:macro_caller\n\n$function example:missing\n',
			}),
		])
	})

	afterEach(async () => {
		await Promise.all([
			rm(errorDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
			rm(warningDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
		])
	})

	async function runMain(args: readonly string[]): Promise<number> {
		const log = console.log
		const error = console.error
		console.log = () => {}
		console.error = () => {}
		try {
			return await main(args)
		} finally {
			console.log = log
			console.error = error
		}
	}

	function cacheArgs(dir: string): string[] {
		return ['--cache', join(dir, '.tsb-lint-cache.json')]
	}

	it('exits 1 when at least one error-severity diagnostic is reported', async () => {
		assert.equal(await runMain([...cacheArgs(errorDir), errorDir]), 1)
	})

	it('exits 0 when only warnings are reported', async () => {
		assert.equal(await runMain([...cacheArgs(warningDir), warningDir]), 0)
	})

	it('exits 1 for warnings under --strict', async () => {
		assert.equal(await runMain(['--strict', ...cacheArgs(warningDir), warningDir]), 1)
	})
})
