import * as core from '@spyglassmc/core'
import { getRefProvenance } from '@spyglassmc/tsb-imp-doc'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import type { LintDiagnostic } from '../lib/reporter.js'
import { cliMcfunction, runImpDocLint } from '../lib/runner.js'
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
				'#> example:partial_dynamic\n\n'
					+ '$function example:$(id)\n'
					+ '$function dir/$(id)\n'
					+ '$execute if function example:missing_static run function example:$(id)\n',
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
				file: partialDynamic,
				line: 5,
				severity: 'warning',
				message:
					'Function “example:missing_static” is referenced in a macro line but is not declared anywhere',
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

		// Static prefixes completed by `$(...)` are skipped across `:` and `/`,
		// while a separate static reference on the same line is retained. The
		// whole file is pinned (not just one rule) so a regression that leaks a
		// skipped prefix into `unresolved` or the strict rule also fails here.
		assert.deepEqual(
			cold.diagnostics
				.filter(diagnostic => diagnostic.file === partialDynamic)
				.map(({ file, line, severity, message, rule }) => ({
					file,
					line,
					severity,
					message,
					rule,
				})),
			[{
				file: partialDynamic,
				line: 5,
				severity: 'warning',
				message:
					'Function “example:missing_static” is referenced in a macro line but is not declared anywhere',
				rule: 'impDocPrivateBestEffort',
			}],
		)

		const warm = await run()
		assert.equal(warm.cacheHit, true)
		assert.deepEqual(warm.diagnostics, cold.diagnostics)
	})

	it('downgrades fully dynamic function references to unresolved warnings', async () => {
		const dynamicFile = join(functionsDir, 'dynamic.mcfunction')
		await writeFile(
			dynamicFile,
			'#> example:dynamic\n\n$function $(target)\n$function #$(tag)\n',
		)

		const result = await run()
		assert.deepEqual(
			digest(
				result.diagnostics.filter(diagnostic => diagnostic.file === dynamicFile),
				'unresolved',
			),
			[
				{
					file: dynamicFile,
					line: 3,
					severity: 'warning',
					message: 'Unresolved dynamic function reference',
				},
				{
					file: dynamicFile,
					line: 4,
					severity: 'warning',
					message: 'Unresolved dynamic function reference',
				},
			],
		)

		const parsed = cliMcfunction(
			new core.Source('$function #$(tag)'),
			{ err: new core.ErrorReporter() } as Parameters<typeof cliMcfunction>[1],
		)
		if (parsed === core.Failure) {
			assert.fail('CLI mcfunction parser unexpectedly failed')
		}
		const markers = parsed.children.filter(
			child => child.type === 'tsb-imp-doc-cli:dynamic-ref',
		)
		assert.equal(markers.length, 1)
		assert.equal(getRefProvenance(markers[0]!), 'dynamic-pattern')
	})
})
