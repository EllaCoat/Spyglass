import * as core from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServiceRuntime, type ServiceRuntime } from './contract-runtime.ts'

const IndexFile = 'data/bare/functions/_index.d.mcfunction'

function createConfig(rule?: unknown): core.Config {
	const config = core.ConfigService.merge(core.VanillaConfig, {
		env: { dependencies: [], exclude: [], gameVersion: '1.20.4' },
	})
	const lint = config.lint as unknown as Record<string, unknown>
	for (const name of Object.keys(lint)) {
		delete lint[name]
	}
	if (rule !== undefined) {
		lint['impDocBareDeclaration'] = rule
	}
	return config
}

async function lintIndex(rule?: unknown): Promise<{
	content: string
	errors: readonly core.LanguageError[]
	close: () => Promise<void>
}> {
	const runtime: ServiceRuntime<'index'> = await createServiceRuntime({
		fixture: 'bare-declaration-project',
		files: { index: IndexFile },
		defaultConfig: createConfig(rule),
		tempPrefix: 'spyglass-imp-doc-bare-',
	})
	return {
		content: runtime.states.index.content,
		errors: runtime.states.index.node.linterErrors ?? [],
		close: runtime.close,
	}
}

describe('impDocBareDeclaration', () => {
	it('reports only the directives that own no IMP-Doc block', async () => {
		const { content, errors, close } = await lintIndex('warning')
		try {
			assert.deepEqual(
				errors.map(error => [
					content.slice(error.range.start, error.range.end),
					error.severity,
				]),
				[
					['BareTag', core.ErrorSeverity.Warning],
					['bare:store', core.ErrorSeverity.Warning],
					['bare:target', core.ErrorSeverity.Warning],
				],
			)
			for (const error of errors) {
				assert.match(error.message, /impDocBareDeclaration/)
				assert.match(error.message, /public/)
			}
			// `ScopedTag` owns a `#>` block, so its `@private` does apply.
			assert.equal(
				errors.some(error => content.slice(error.range.start, error.range.end) === 'ScopedTag'),
				false,
			)
		} finally {
			await close()
		}
	})

	it('honours the configured severity', async () => {
		const { errors, close } = await lintIndex('error')
		try {
			assert.deepEqual(
				errors.map(error => error.severity),
				[
					core.ErrorSeverity.Error,
					core.ErrorSeverity.Error,
					core.ErrorSeverity.Error,
				],
			)
		} finally {
			await close()
		}
	})

	it('stays silent when the rule is not configured', async () => {
		const { errors, close } = await lintIndex()
		try {
			assert.deepEqual(errors, [])
		} finally {
			await close()
		}
	})
})
