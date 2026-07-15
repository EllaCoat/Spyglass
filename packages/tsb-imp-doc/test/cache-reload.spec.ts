import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { getImpDocSymbolData, initialize as initializeImpDoc } from '../lib/index.js'

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
	new URL(
		'./runtime/private-project/data/contract/functions/target.mcfunction',
		import.meta.url,
	).toString(),
	new URL(
		'./runtime/private-project/data/contract/functions/caller.mcfunction',
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
	lint['impDocPrivate'] = lintLevel
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
	restoredContractInputCount: number
	close: () => Promise<void>
}> {
	const project = createProject(options)
	await project.init()
	const restoredFileCount = Object.keys(
		project.cacheService.checksums.files,
	).length
	const restoredContractInputCount = getImpDocSymbolData(
		project.symbols.lookup('function', ['contract:target']).symbol?.data,
	)?.contract?.inputs.length ?? 0
	return { restoredFileCount, restoredContractInputCount, close: () => project.close() }
}

describe('IMP-Doc cache reload correctness (P1b Step 4)', () => {
	let cacheDir: string

	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-cache-'))
	})

	afterEach(async () => {
		await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
	})

	it('reuses cache when initializer context matches', async () => {
		await runFull({ cacheDir, pluginVersion: 'v-fixture-1' })
		const { restoredContractInputCount, restoredFileCount, close } = await runInit({
			cacheDir,
			pluginVersion: 'v-fixture-1',
		})
		assert.ok(
			restoredFileCount > 0,
			`Expected cache to restore checksums; got ${restoredFileCount}`,
		)
		assert.ok(restoredContractInputCount > 0, 'Expected cached IMP-Doc contract data')
		await close()
	})

	it('fingerprints initializer and lint cache context independently', async () => {
		const project = createProject({ cacheDir, pluginVersion: 'v-fixture-1' })
		try {
			await project.init()
			const base = await project.cacheService.prepareContext({
				initializerContext: project.ctx,
				lint: project.config.lint,
			})
			assert.equal(base.changed, false)
			assert.deepEqual(base.changedHashKinds, [])

			const lint = structuredClone(project.config.lint) as
				& core.LinterConfig
				& Record<string, unknown>
			lint['impDocPrivate'] = 'warning'
			const lintChanged = await project.cacheService.prepareContext({
				initializerContext: project.ctx,
				lint,
			})
			assert.deepEqual(lintChanged.changedHashKinds, ['lint'])
			assert.equal(lintChanged.initializerHash, base.initializerHash)
			assert.notEqual(lintChanged.lintHash, base.lintHash)

			const initializerChanged = await project.cacheService.prepareContext({
				initializerContext: { ...project.ctx, binaryHashFixture: 'v2' },
				lint: project.config.lint,
			})
			assert.deepEqual(initializerChanged.changedHashKinds, ['initializer'])
			assert.notEqual(initializerChanged.initializerHash, base.initializerHash)
			assert.equal(initializerChanged.lintHash, base.lintHash)
		} finally {
			await project.close()
		}
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

	it('drops cache errors and re-lints open documents with the new severity when lint config changes', async () => {
		// 初回 project = Error severity で lint、 cacheService.errors に診断を確実に入れる。
		const first = createProject({
			cacheDir,
			pluginVersion: 'v-fixture-1',
			lintLevel: 'error',
		})
		try {
			await first.init()
			const watcher = new FixtureWatcher([PackMcmetaUri, ...RuntimeFileUris])
			await first.ready({ projectRootsWatcher: watcher })

			const callerUri = RuntimeFileUris[3]
			assert.ok(callerUri)
			const firstContent = await first.externals.fs.readFile(callerUri)
			await first.onDidOpen(
				callerUri,
				'mcfunction',
				1,
				new TextDecoder().decode(firstContent),
			)
			// onDidOpen は bind/check を直接呼ぶだけで documentUpdated を emit しない
			// (Project.ts:912-931)。 documentErrored 経路 → cacheService.errors[uri]
			// への反映は ensureClientManagedChecked を明示的に呼ぶ必要がある
			// (Project.ts:980-990)。
			await first.ensureClientManagedChecked(callerUri)
			const firstState = first.getClientManaged(callerUri)
			assert.ok(firstState)
			assert.equal(firstState.node.linterErrors?.length, 1)
			assert.equal(
				firstState.node.linterErrors?.[0]?.severity,
				core.ErrorSeverity.Error,
			)
			// stale errors 検出 regression の precondition = callerUri 自身の Error
			// 診断が cache に確実に入っている ("errors が非空" だけの assert は他
			// fixture URI の空 entry でも成立し regression を捕捉できない)。
			const firstCachedErrors = first.cacheService.errors[callerUri]
			assert.ok(
				firstCachedErrors,
				`Expected cacheService.errors[${callerUri}] to be populated`,
			)
			assert.equal(firstCachedErrors.length, 1)
			assert.equal(
				firstCachedErrors[0]?.severity,
				core.ErrorSeverity.Error,
			)
		} finally {
			await first.close()
		}

		// 2 回目 project = lint level を warning に変えて init、 cache 破棄と再 lint を verify。
		const second = createProject({
			cacheDir,
			pluginVersion: 'v-fixture-1',
			lintLevel: 'warning',
		})
		try {
			await second.init()
			const restoredFileCount = Object.keys(
				second.cacheService.checksums.files,
			).length
			assert.equal(
				restoredFileCount,
				0,
				`Expected cache to be dropped on lint config change; got ${restoredFileCount}`,
			)
			// checksums だけでなく stale errors も破棄されないと、 「drop 忘れ」 regression を
			// 後段の onDidOpen で新 lint が上書きしてしまい検出できない。
			assert.equal(
				Object.keys(second.cacheService.errors).length,
				0,
				'Expected cacheService.errors to be dropped on lint config change',
			)

			const watcher = new FixtureWatcher([PackMcmetaUri, ...RuntimeFileUris])
			await second.ready({ projectRootsWatcher: watcher })

			const callerUri = RuntimeFileUris[3]
			assert.ok(callerUri)
			const content = await second.externals.fs.readFile(callerUri)
			await second.onDidOpen(
				callerUri,
				'mcfunction',
				1,
				new TextDecoder().decode(content),
			)
			const state = second.getClientManaged(callerUri)
			assert.ok(state)
			assert.equal(state.node.linterErrors?.length, 1)
			assert.equal(
				state.node.linterErrors?.[0]?.severity,
				core.ErrorSeverity.Warning,
			)
		} finally {
			await second.close()
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

			// impDocPrivate は tsb-imp-doc が dynamic 登録する custom lint rule で、
			// core.LinterConfig の静的 shape には現れないため型を明示 escape する。
			await project.onEditorConfigurationUpdate({
				lint: { impDocPrivate: 'warning' } as unknown as core.LinterConfig,
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
