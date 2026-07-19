import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { LintDiagnostic } from '../lib/reporter.js'
import { runImpDocLint } from '../lib/runner.js'
import { scanMcfunctionFiles } from '../lib/scanner.js'

interface DiagnosticDigest {
	file: string
	line: number
	severity: LintDiagnostic['severity']
	message: string
}

function digest(diagnostics: readonly LintDiagnostic[], rule: string): DiagnosticDigest[] {
	return diagnostics
		.filter(diagnostic => diagnostic.rule === rule)
		.map(({ file, line, severity, message }) => ({ file, line, severity, message }))
}

describe('runner best-effort reference provenance', () => {
	let projectDir: string
	let functionsDir: string
	let strictCaller: string
	let macroCaller: string
	let quoteCaller: string
	let partialDynamic: string

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cli-provenance-'))
		functionsDir = join(projectDir, 'data', 'example', 'functions')
		await mkdir(functionsDir, { recursive: true })
		strictCaller = join(functionsDir, 'strict_caller.mcfunction')
		macroCaller = join(functionsDir, 'macro_caller.mcfunction')
		quoteCaller = join(functionsDir, 'quote_caller.mcfunction')
		partialDynamic = join(functionsDir, 'partial_dynamic.mcfunction')
		await Promise.all([
			writeFile(
				join(functionsDir, 'private.mcfunction'),
				'#> example:private\n# @private\n\nsay private\n',
			),
			writeFile(strictCaller, '#> example:strict_caller\n\nfunction example:private\n'),
			writeFile(
				macroCaller,
				'#> example:macro_caller\n\n'
					+ '$execute as @a run function example:private\n'
					+ '$function example:missing_macro\n',
			),
			writeFile(
				quoteCaller,
				'#> example:quote_caller\n\n'
					+ 'execute if data storage example:store {value: "function example:private"} run say hi\n'
					+ "say 'function example:quote_missing'\n",
			),
			writeFile(
				partialDynamic,
				'#> example:partial_dynamic\n\n$function example:generated/$(id)\n',
			),
		])
	})

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
	})

	async function run() {
		const files = await scanMcfunctionFiles(projectDir)
		return runImpDocLint(files, {
			targetDir: projectDir,
			parallel: 2,
			cachePath: join(projectDir, '.tsb-lint-cache.json'),
		})
	}

	it('routes macro and quoted references to impDocPrivateBestEffort as warnings', async () => {
		const cold = await run()

		// The strict rule stays on plain references and never sees tagged ones.
		assert.deepEqual(digest(cold.diagnostics, 'impDocPrivate'), [{
			file: strictCaller,
			line: 3,
			severity: 'error',
			message:
				'Function “example:private” is private to “example:private” and cannot be called from “example:strict_caller”',
		}])

		assert.deepEqual(digest(cold.diagnostics, 'impDocPrivateBestEffort'), [
			{
				file: macroCaller,
				line: 3,
				severity: 'warning',
				message:
					'Function “example:private” is private to “example:private” and cannot be called from “example:macro_caller” (referenced in a macro line)',
			},
			{
				file: macroCaller,
				line: 4,
				severity: 'warning',
				message:
					'Function “example:missing_macro” is referenced in a macro line but is not declared anywhere',
			},
			{
				file: quoteCaller,
				line: 3,
				severity: 'warning',
				message:
					'Function “example:private” is private to “example:private” and cannot be called from “example:quote_caller” (referenced in a quoted string)',
			},
			{
				file: quoteCaller,
				line: 4,
				severity: 'warning',
				message:
					'Function “example:quote_missing” is referenced in a quoted string but is not declared anywhere',
			},
		])

		// A static prefix completed by `$(...)` is never turned into a reference,
		// so the partial dynamic file stays clean.
		assert.deepEqual(
			cold.diagnostics.filter(diagnostic => diagnostic.file === partialDynamic),
			[],
		)

		const warm = await run()
		assert.equal(warm.cacheHit, true)
		assert.deepEqual(warm.diagnostics, cold.diagnostics)
	})
})
