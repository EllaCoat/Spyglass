import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { initialize as initializeImpDoc } from '../lib/index.js'

const FixtureRoot = core.fileUtil.ensureEndingSlash(
	new URL('./runtime/private-project/', import.meta.url).toString(),
)

const RuntimeFileUris = [
	new URL(
		'./runtime/private-project/data/owner/functions/_index.d.mcfunction',
		import.meta.url,
	).toString(),
	new URL(
		'./runtime/private-project/data/owner/functions/helper.mcfunction',
		import.meta.url,
	).toString(),
	new URL(
		'./runtime/private-project/data/owner/functions/main.mcfunction',
		import.meta.url,
	).toString(),
	new URL(
		'./runtime/private-project/data/external/functions/caller.mcfunction',
		import.meta.url,
	).toString(),
	new URL(
		'./runtime/private-project/data/other/functions/denied.mcfunction',
		import.meta.url,
	).toString(),
]

const PackMcmetaUri = new URL(
	'./runtime/private-project/pack.mcmeta',
	import.meta.url,
).toString()

const Commands: je.dependency.McmetaCommands = {
	type: 'root',
	children: {
		function: {
			type: 'literal',
			children: {
				name: {
					type: 'argument',
					parser: 'minecraft:function',
					executable: true,
				},
			},
		},
	},
}

class FixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
	implements core.FileWatcher
{
	readonly watchedFiles = new core.UriStore()

	constructor(uris: readonly string[]) {
		super()
		for (const uri of uris) {
			this.watchedFiles.add(uri)
		}
	}

	async ready(): Promise<void> {}

	async close(): Promise<void> {}
}

function createConfig(
	lintLevel: 'error' | 'warning' | 'hint' | 'information',
): core.Config {
	const config = core.ConfigService.merge(core.VanillaConfig, {
		env: {
			dependencies: [],
			exclude: [],
			gameVersion: '1.20.4',
		},
	})
	const lint = config.lint as unknown as Record<string, unknown>
	for (const rule of Object.keys(lint)) {
		delete lint[rule]
	}
	lint.impDocPrivate = lintLevel
	return config
}

interface RunOptions {
	cacheDir: string
	pluginVersion?: string
	lintLevel?: 'error' | 'warning' | 'hint' | 'information'
}

function createProject(options: RunOptions): core.Project {
	const initializer: core.ProjectInitializer = async (ctx) => {
		ctx.meta.registerUriBinder(je.binder.uriBinder)
		je.mcf.initialize(ctx, Commands, '1.20.4')
		const inner = (await initializeImpDoc(ctx)) ?? {}
		const merged: Record<string, string> = {
			...inner,
			loadedVersion: '1.20.4',
			errorSource: '1.20.4',
		}
		if (options.pluginVersion) {
			merged['plugin:@spyglassmc/tsb-imp-doc'] = options.pluginVersion
		}
		return merged
	}

	return new core.Project({
		cacheRoot: core.fileUtil.ensureEndingSlash(
			pathToFileURL(options.cacheDir).toString(),
		),
		defaultConfig: createConfig(options.lintLevel ?? 'error'),
		externals: NodeJsExternals,
		initializers: [initializer],
		logger: {
			error: () => {},
			info: () => {},
			log: () => {},
			warn: () => {},
		},
		projectRoots: [FixtureRoot],
	})
}

async function runFull(options: RunOptions): Promise<void> {
	const project = createProject(options)
	await project.init()
	const watcher = new FixtureWatcher([PackMcmetaUri, ...RuntimeFileUris])
	await project.ready({ projectRootsWatcher: watcher })
	await project.close()
}

async function runInit(options: RunOptions): Promise<{
	restoredFileCount: number
	close: () => Promise<void>
}> {
	const project = createProject(options)
	await project.init()
	const restoredFileCount = Object.keys(
		project.cacheService.checksums.files,
	).length
	return { restoredFileCount, close: () => project.close() }
}

describe('IMP-Doc cache reload correctness (P1b Step 4)', () => {
	let cacheDir: string

	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cache-'))
	})

	afterEach(async () => {
		await rm(cacheDir, { recursive: true, force: true })
	})

	it('reuses cache when initializer context matches', async () => {
		await runFull({ cacheDir, pluginVersion: 'v-fixture-1' })
		const { restoredFileCount, close } = await runInit({
			cacheDir,
			pluginVersion: 'v-fixture-1',
		})
		assert.ok(
			restoredFileCount > 0,
			`Expected cache to restore checksums; got ${restoredFileCount}`,
		)
		await close()
	})

	it('drops cache when initializer version changes', async () => {
		await runFull({ cacheDir, pluginVersion: 'v-fixture-1' })
		const { restoredFileCount, close } = await runInit({
			cacheDir,
			pluginVersion: 'v-fixture-2',
		})
		assert.equal(
			restoredFileCount,
			0,
			`Expected cache to be dropped on plugin version change; got ${restoredFileCount}`,
		)
		await close()
	})

	it('drops cache and re-lints open documents with the new severity when lint config changes', async () => {
		await runFull({
			cacheDir,
			pluginVersion: 'v-fixture-1',
			lintLevel: 'error',
		})
		const project = createProject({
			cacheDir,
			pluginVersion: 'v-fixture-1',
			lintLevel: 'warning',
		})
		try {
			await project.init()
			const restoredFileCount = Object.keys(
				project.cacheService.checksums.files,
			).length
			assert.equal(
				restoredFileCount,
				0,
				`Expected cache to be dropped on lint config change; got ${restoredFileCount}`,
			)

			const watcher = new FixtureWatcher([PackMcmetaUri, ...RuntimeFileUris])
			await project.ready({ projectRootsWatcher: watcher })

			const callerUri = RuntimeFileUris[3]
			assert.ok(callerUri)
			const content = await project.externals.fs.readFile(callerUri)
			await project.onDidOpen(
				callerUri,
				'mcfunction',
				1,
				new TextDecoder().decode(content),
			)
			const state = project.getClientManaged(callerUri)
			assert.ok(state)
			assert.equal(state.node.linterErrors?.length, 1)
			assert.equal(
				state.node.linterErrors?.[0]?.severity,
				core.ErrorSeverity.Warning,
			)
		} finally {
			await project.close()
		}
	})

	it('resets cache and re-lints open documents after a hot lint config change', async () => {
		const project = createProject({
			cacheDir,
			pluginVersion: 'v-fixture-1',
			lintLevel: 'error',
		})
		try {
			await project.init()
			const watcher = new FixtureWatcher([PackMcmetaUri, ...RuntimeFileUris])
			await project.ready({ projectRootsWatcher: watcher })

			const callerUri = RuntimeFileUris[3]
			assert.ok(callerUri)
			const content = await project.externals.fs.readFile(callerUri)
			await project.onDidOpen(
				callerUri,
				'mcfunction',
				1,
				new TextDecoder().decode(content),
			)
			let state = project.getClientManaged(callerUri)
			assert.ok(state)
			assert.equal(state.node.linterErrors?.length, 1)
			assert.equal(state.node.linterErrors?.[0]?.severity, core.ErrorSeverity.Error)

			await project.onEditorConfigurationUpdate({
				lint: { impDocPrivate: 'warning' },
			})
			state = project.getClientManaged(callerUri)
			assert.ok(state)
			assert.equal(state.node.linterErrors?.length, 1)
			assert.equal(state.node.linterErrors?.[0]?.severity, core.ErrorSeverity.Warning)
		} finally {
			await project.close()
		}

		const { restoredFileCount, close } = await runInit({
			cacheDir,
			pluginVersion: 'v-fixture-1',
			lintLevel: 'warning',
		})
		assert.ok(restoredFileCount > 0)
		await close()
	})
})
