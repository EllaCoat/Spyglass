import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as json from '@spyglassmc/json'
import * as mcdoc from '@spyglassmc/mcdoc'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import * as je from '../../lib/index.js'
import { getPackFormatContext, getProjectPacks } from '../../lib/packFormat.js'

const FixtureRoot = new URL(
	'./fixture/pack-format-flip-project/',
	import.meta.url,
)

class FixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
	implements core.FileWatcher
{
	readonly watchedFiles = new core.UriStore()

	constructor(...uris: string[]) {
		super()
		for (const uri of uris) {
			this.watchedFiles.add(uri)
		}
	}

	async ready(): Promise<void> {}

	async close(): Promise<void> {}
}

describe('Project pack format reinitialization (#1212)', () => {
	let cacheDir: string
	let projectDir: string
	let packMcmetaUri: string

	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-pack-format-cache-'))
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-pack-format-project-'))
		packMcmetaUri = new URL('pack.mcmeta', pathToFileURL(`${projectDir}/`)).toString()
		await copyPackFormat(6)
	})

	afterEach(async () => {
		await Promise.all([
			rm(cacheDir, { recursive: true, force: true }),
			rm(projectDir, { recursive: true, force: true }),
		])
	})

	async function copyPackFormat(format: 6 | 42): Promise<void> {
		await copyFile(
			new URL(`./format-${format}/pack.mcmeta`, FixtureRoot),
			new URL(packMcmetaUri),
		)
	}

	async function waitForFileChecksum(project: core.Project, uri: string): Promise<void> {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (project.cacheService.checksums.files[uri] !== undefined) {
				return
			}
			await new Promise<void>(resolve => setImmediate(resolve))
		}
		assert.fail(`Timed out waiting for checksum of ${uri}`)
	}

	function createProject(
		onInitialize: (format: number) => Promise<void> | void,
		{
			shouldFailInitializer = () => false,
			shouldFailRegistrar = () => false,
		}: {
			shouldFailInitializer?: () => boolean
			shouldFailRegistrar?: () => boolean
		} = {},
	): core.Project {
		const initializer: core.ProjectInitializer = async (ctx) => {
			const packs = await getProjectPacks(ctx)
			const format = packs.find(pack => pack.packRoot === core.fileUtil.dirname(packMcmetaUri))
				?.format
			assert.ok(format !== undefined)
			await onInitialize(format)
			if (shouldFailInitializer()) {
				throw new Error('Injected initializer failure')
			}

			json.getInitializer()(ctx)
			ctx.meta.registerSymbolRegistrar('pack-format-fixture', {
				checksum: `${format}`,
				registrar: (symbols) => {
					if (shouldFailRegistrar()) {
						throw new Error('Injected registrar failure')
					}
					symbols.query(packMcmetaUri, 'pack_format', `${format}`).enter({
						usage: { type: 'declaration' },
					})
				},
			})
			return getPackFormatContext(packs)
		}

		return new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
			defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
				env: { dependencies: [], exclude: [] },
			}),
			externals: NodeJsExternals,
			initializers: [initializer],
			logger: core.Logger.noop(),
			projectRoots: [
				core.fileUtil.ensureEndingSlash(pathToFileURL(projectDir).toString()),
			],
		})
	}

	it('drops cache and rebuilds symbols after watched pack_format changes', async () => {
		const initializedFormats: number[] = []
		const project = createProject((format) => {
			initializedFormats.push(format)
		})
		const watcher = new FixtureWatcher(packMcmetaUri)
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })
			assert.ok(project.symbols.lookup('pack_format', ['6']).symbol)

			await copyPackFormat(42)
			const reinitialized = new Promise<boolean>((resolve) => {
				project.on(
					'reinitialized',
					({ contextChanged }) => resolve(contextChanged),
					{ once: true },
				)
			})
			watcher.emit('change', packMcmetaUri)
			assert.equal(await reinitialized, true)

			assert.deepEqual(initializedFormats, [6, 42])
			assert.equal(project.symbols.lookup('pack_format', ['6']).symbol, undefined)
			assert.ok(project.symbols.lookup('pack_format', ['42']).symbol)
		} finally {
			await project.close()
		}
	})

	it('drops a persisted cache when pack_format changes between project instances', async () => {
		const first = createProject(() => {})
		try {
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(packMcmetaUri) })
		} finally {
			await first.close()
		}

		await copyPackFormat(42)
		const second = createProject(() => {})
		try {
			await second.init()
			assert.equal(Object.keys(second.cacheService.checksums.files).length, 0)
			await second.ready({ projectRootsWatcher: new FixtureWatcher(packMcmetaUri) })
			assert.equal(second.symbols.lookup('pack_format', ['6']).symbol, undefined)
			assert.ok(second.symbols.lookup('pack_format', ['42']).symbol)
		} finally {
			await second.close()
		}
	})

	it('keeps the ready project when pack metadata changes without changing pack_format', async () => {
		const project = createProject(() => {})
		const watcher = new FixtureWatcher(packMcmetaUri)
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })

			const updatedDescription = 'Same format, updated description'
			await writeFile(
				new URL(packMcmetaUri),
				JSON.stringify({ pack: { description: updatedDescription, pack_format: 6 } }),
			)
			const reinitialized = new Promise<boolean>((resolve) => {
				project.on(
					'reinitialized',
					({ contextChanged }) => resolve(contextChanged),
					{ once: true },
				)
			})
			const documentUpdated = new Promise<core.DocAndNode>((resolve) => {
				project.on('documentUpdated', (event) => {
					if (event.doc.uri === packMcmetaUri) {
						resolve(event)
					}
				}, { once: true })
			})
			const diagnosticsUpdated = new Promise<readonly core.PosRangeLanguageError[]>(
				(resolve) => {
					project.on('documentErrored', ({ errors, uri }) => {
						if (uri === packMcmetaUri) {
							resolve(errors)
						}
					}, { once: true })
				},
			)
			watcher.emit('change', packMcmetaUri)

			assert.equal(await reinitialized, false)
			const updated = await documentUpdated
			assert.match(updated.doc.getText(), new RegExp(updatedDescription))
			assert.ok(updated.node.children.length > 0)
			assert.deepEqual(await diagnosticsUpdated, [])
			assert.equal(project.isReady, true)
			assert.ok(project.symbols.lookup('pack_format', ['6']).symbol)
		} finally {
			await project.close()
		}
	})

	it('re-runs initializers when another pack change arrives during reinitialization', async () => {
		const initializedFormats: number[] = []
		let releaseSecondInitialization!: () => void
		const secondInitializationStarted = Promise.withResolvers<void>()
		const secondInitializationRelease = new Promise<void>((resolve) => {
			releaseSecondInitialization = resolve
		})
		const project = createProject(async (format) => {
			initializedFormats.push(format)
			if (initializedFormats.length === 2) {
				secondInitializationStarted.resolve()
				await secondInitializationRelease
			}
		})
		const watcher = new FixtureWatcher(packMcmetaUri)
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })

			const twoReinitializations = new Promise<void>((resolve) => {
				let count = 0
				project.on('reinitialized', () => {
					count += 1
					if (count === 2) {
						resolve()
					}
				})
			})
			await copyPackFormat(42)
			watcher.emit('change', packMcmetaUri)
			await secondInitializationStarted.promise
			await copyPackFormat(6)
			watcher.emit('change', packMcmetaUri)
			releaseSecondInitialization()
			await twoReinitializations

			assert.deepEqual(initializedFormats, [6, 42, 6])
			assert.ok(project.symbols.lookup('pack_format', ['6']).symbol)
			assert.equal(project.symbols.lookup('pack_format', ['42']).symbol, undefined)
		} finally {
			await project.close()
		}
	})

	it('serializes config updates behind an active reinitialization', async () => {
		let initializationCount = 0
		let releaseReinitialization!: () => void
		const reinitializationStarted = Promise.withResolvers<void>()
		const reinitializationRelease = new Promise<void>((resolve) => {
			releaseReinitialization = resolve
		})
		const project = createProject(async () => {
			initializationCount += 1
			if (initializationCount === 2) {
				reinitializationStarted.resolve()
				await reinitializationRelease
			}
		})
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: new FixtureWatcher(packMcmetaUri) })
			await copyPackFormat(42)
			const reinitialization = project.reinitialize()
			await reinitializationStarted.promise

			const configChanged = new Promise<void>((resolve) => {
				project.on('configChanged', () => resolve(), { once: true })
			})
			const configUpdate = project.onEditorConfigurationUpdate({
				env: { feature: { hover: false } },
			})
			assert.notEqual(project.config.env.feature.hover, false)

			releaseReinitialization()
			await Promise.all([reinitialization, configUpdate, configChanged])
			assert.equal(project.config.env.feature.hover, false)
		} finally {
			await project.close()
		}
	})

	it('rolls back staged project and cache state when rebuild fails', async () => {
		let failRegistrar = false
		const project = createProject(() => {}, {
			shouldFailRegistrar: () => failRegistrar,
		})
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: new FixtureWatcher(packMcmetaUri) })
			await waitForFileChecksum(project, packMcmetaUri)
			const previous = {
				checksums: structuredClone(project.cacheService.checksums),
				ctx: project.ctx,
				errors: structuredClone(project.cacheService.errors),
				meta: project.meta,
				symbols: project.symbols,
			}

			await copyPackFormat(42)
			failRegistrar = true
			await assert.rejects(project.reinitialize(), /Injected registrar failure/)

			assert.deepEqual(project.cacheService.checksums, previous.checksums)
			assert.equal(project.ctx, previous.ctx)
			assert.deepEqual(project.cacheService.errors, previous.errors)
			assert.equal(project.meta, previous.meta)
			assert.equal(project.symbols, previous.symbols)
			assert.equal(project.isReady, true)
			assert.ok(project.symbols.lookup('pack_format', ['6']).symbol)
			assert.equal(project.symbols.lookup('pack_format', ['42']).symbol, undefined)

			failRegistrar = false
			await project.reinitialize()
			assert.ok(project.symbols.lookup('pack_format', ['42']).symbol)
		} finally {
			await project.close()
		}
	})

	it('keeps the active initializer snapshot when a reinitializer rejects', async () => {
		let failInitializer = false
		const project = createProject(() => {}, {
			shouldFailInitializer: () => failInitializer,
		})
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: new FixtureWatcher(packMcmetaUri) })
			const previous = {
				ctx: project.ctx,
				meta: project.meta,
				symbols: project.symbols,
			}

			await copyPackFormat(42)
			failInitializer = true
			await assert.rejects(project.reinitialize(), AggregateError)

			assert.equal(project.ctx, previous.ctx)
			assert.equal(project.meta, previous.meta)
			assert.equal(project.symbols, previous.symbols)
			assert.equal(project.isReady, true)
			assert.ok(project.symbols.lookup('pack_format', ['6']).symbol)
			assert.equal(project.symbols.lookup('pack_format', ['42']).symbol, undefined)
		} finally {
			await project.close()
		}
	})

	it('discovers and reinitializes packs nested more than three levels deep', async () => {
		const deepDir = join(projectDir, 'one', 'two', 'three', 'four')
		await mkdir(deepDir, { recursive: true })
		const deepPackMcmetaUri = pathToFileURL(join(deepDir, 'pack.mcmeta')).toString()
		await copyFile(
			new URL('./format-6/pack.mcmeta', FixtureRoot),
			new URL(deepPackMcmetaUri),
		)
		const seenDeepFormats: Array<number | undefined> = []
		const initializer: core.ProjectInitializer = async (ctx) => {
			const packs = await getProjectPacks(ctx)
			json.getInitializer()(ctx)
			seenDeepFormats.push(
				packs.find(pack => pack.packRoot === core.fileUtil.dirname(deepPackMcmetaUri))?.format,
			)
			return getPackFormatContext(packs)
		}
		const project = new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
			defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
				env: { dependencies: [], exclude: [] },
			}),
			externals: NodeJsExternals,
			initializers: [initializer],
			logger: core.Logger.noop(),
			projectRoots: [core.fileUtil.ensureEndingSlash(pathToFileURL(projectDir).toString())],
		})
		const watcher = new FixtureWatcher(deepPackMcmetaUri)
		try {
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })
			await copyFile(
				new URL('./format-42/pack.mcmeta', FixtureRoot),
				new URL(deepPackMcmetaUri),
			)
			const reinitialized = new Promise<boolean>((resolve) => {
				project.on('reinitialized', ({ contextChanged }) => resolve(contextChanged), {
					once: true,
				})
			})
			watcher.emit('change', deepPackMcmetaUri)

			assert.equal(await reinitialized, true)
			assert.deepEqual(seenDeepFormats, [6, 42])
		} finally {
			await project.close()
		}
	})
})

describe('Project cache reset (#1975)', () => {
	const fixtureRoot = core.fileUtil.ensureEndingSlash(
		new URL('./fixture/reset-project-cache/', import.meta.url).toString(),
	)
	const fixtureFiles = {
		pack: new URL('./fixture/reset-project-cache/pack.mcmeta', import.meta.url).toString(),
		caller: new URL(
			'./fixture/reset-project-cache/data/example/functions/a.mcfunction',
			import.meta.url,
		).toString(),
		callee: new URL(
			'./fixture/reset-project-cache/data/example/functions/b.mcfunction',
			import.meta.url,
		).toString(),
	} as const
	const commands: je.dependency.McmetaCommands = {
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
	type ResetHooks = {
		checkedUris: Set<string>
		failBindUri?: string
	}

	class ResetFixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
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

	function getLinterErrors(project: core.Project): readonly core.LanguageError[] {
		const caller = project.getClientManaged(fixtureFiles.caller)
		assert.ok(caller)
		return caller.node.linterErrors ?? []
	}

	async function createResetProject(hooks: ResetHooks): Promise<{
		cacheDir: string
		project: core.Project
	}> {
		const cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-reset-cache-'))
		const initializer: core.ProjectInitializer = (ctx) => {
			ctx.meta.registerUriBinder(je.binder.uriBinder)
			je.mcf.initialize(ctx, commands, '1.20.4')
			ctx.meta.registerBinder(
				'file',
				core.AsyncBinder.create(async (node, binderCtx) => {
					if (hooks.failBindUri === binderCtx.doc.uri) {
						throw new Error(`Injected bind failure for ${binderCtx.doc.uri}`)
					}
					await Promise.all(
						(node.children ?? []).map(child => core.binder.fallback(child, binderCtx)),
					)
				}),
			)
			ctx.meta.registerChecker('file', async (node, checkerCtx) => {
				await Promise.all(
					(node.children ?? []).map(child => core.checker.fallback(child, checkerCtx)),
				)
				hooks.checkedUris.add(checkerCtx.doc.uri)
			})
			return { loadedVersion: '1.20.4', errorSource: '1.20.4' }
		}
		const project = new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
			defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
				env: { dependencies: [], exclude: [], gameVersion: '1.20.4' },
			}),
			externals: NodeJsExternals,
			initializers: [initializer],
			logger: core.Logger.noop(),
			projectRoots: [fixtureRoot],
		})
		return { cacheDir, project }
	}

	it('publishes all open-document diagnostics after every check and before ready', async () => {
		const hooks: ResetHooks = { checkedUris: new Set() }
		const { cacheDir, project } = await createResetProject(hooks)
		try {
			await project.init()
			await project.ready({
				projectRootsWatcher: new ResetFixtureWatcher(Object.values(fixtureFiles)),
			})
			const openUris = [fixtureFiles.caller, fixtureFiles.callee]
			for (const uri of openUris) {
				await project.onDidOpen(uri, 'mcfunction', 1, await readFile(new URL(uri), 'utf8'))
			}
			assert.deepEqual(getLinterErrors(project), [])

			hooks.checkedUris.clear()
			const updatedUris = new Set<string>()
			const completedDiagnostics = new Set<string>()
			const eventOrder: string[] = []
			project.on('documentUpdated', ({ doc }) => {
				if (openUris.includes(doc.uri)) {
					assert.deepEqual(hooks.checkedUris, new Set(openUris))
					updatedUris.add(doc.uri)
					eventOrder.push(`updated:${doc.uri}`)
				}
			}).on('documentErrored', async ({ uri }) => {
				if (openUris.includes(uri)) {
					assert.deepEqual(hooks.checkedUris, new Set(openUris))
					await new Promise<void>(resolve => setImmediate(resolve))
					completedDiagnostics.add(uri)
					eventOrder.push(`errored:${uri}`)
				}
			}).on('ready', () => {
				assert.deepEqual(completedDiagnostics, new Set(openUris))
				eventOrder.push('ready')
			})

			await project.resetCache()
			assert.deepEqual(updatedUris, new Set(openUris))
			assert.deepEqual(completedDiagnostics, new Set(openUris))
			assert.equal(eventOrder.at(-1), 'ready')
			assert.deepEqual(getLinterErrors(project), [])

			const content = await readFile(new URL(fixtureFiles.caller), 'utf8')
			await project.onDidChange(
				fixtureFiles.caller,
				[{ text: `${content}\n` }],
				2,
			)
			await project.ensureClientManagedChecked(fixtureFiles.caller)

			assert.deepEqual(getLinterErrors(project), [])
		} finally {
			await project.close()
			await rm(cacheDir, { recursive: true, force: true })
		}
	})

	it('rolls back state without publishing staged diagnostics when binding fails', async () => {
		const hooks: ResetHooks = { checkedUris: new Set() }
		const { cacheDir, project } = await createResetProject(hooks)
		try {
			await project.init()
			await project.ready({
				projectRootsWatcher: new ResetFixtureWatcher(Object.values(fixtureFiles)),
			})
			await project.onDidOpen(
				fixtureFiles.caller,
				'mcfunction',
				1,
				'function example:missing',
			)
			await project.onDidOpen(
				fixtureFiles.callee,
				'mcfunction',
				1,
				await readFile(new URL(fixtureFiles.callee), 'utf8'),
			)
			let displayedDiagnostics: readonly core.PosRangeLanguageError[] = []
			project.on('documentErrored', ({ errors, uri }) => {
				if (uri === fixtureFiles.caller) {
					displayedDiagnostics = errors
				}
			})
			await project.ensureClientManagedChecked(fixtureFiles.caller)
			assert.ok(getLinterErrors(project).length > 0)
			const previousDisplayedDiagnostics = structuredClone(displayedDiagnostics)
			assert.ok(previousDisplayedDiagnostics.length > 0)

			const previous = {
				caller: project.getClientManaged(fixtureFiles.caller),
				callee: project.getClientManaged(fixtureFiles.callee),
				checksums: structuredClone(project.cacheService.checksums),
				errors: structuredClone(project.cacheService.errors),
				symbols: project.symbols,
			}
			const publishedEvents: string[] = []
			project.on('documentUpdated', ({ doc }) => publishedEvents.push(`updated:${doc.uri}`))
				.on('documentErrored', ({ uri }) => publishedEvents.push(`errored:${uri}`))
				.on('ready', () => publishedEvents.push('ready'))

			hooks.failBindUri = fixtureFiles.callee
			await assert.rejects(project.reset(), /Injected bind failure/)

			assert.equal(project.bindingInProgressCount, 0)
			assert.equal(project.getClientManaged(fixtureFiles.caller), previous.caller)
			assert.equal(project.getClientManaged(fixtureFiles.callee), previous.callee)
			assert.deepEqual(project.cacheService.checksums, previous.checksums)
			assert.deepEqual(project.cacheService.errors, previous.errors)
			assert.equal(project.symbols, previous.symbols)
			assert.equal(project.isReady, true)
			assert.deepEqual(publishedEvents, [])
			assert.deepEqual(displayedDiagnostics, previousDisplayedDiagnostics)
			assert.ok(getLinterErrors(project).length > 0)
		} finally {
			await project.close()
			await rm(cacheDir, { recursive: true, force: true })
		}
	})

	it('keeps the old context hash after a failed config rebuild so the same update retries', async () => {
		const hooks: ResetHooks = { checkedUris: new Set() }
		const { cacheDir, project } = await createResetProject(hooks)
		try {
			await project.init()
			await project.ready({
				projectRootsWatcher: new ResetFixtureWatcher(Object.values(fixtureFiles)),
			})
			await project.onDidOpen(
				fixtureFiles.caller,
				'mcfunction',
				1,
				await readFile(new URL(fixtureFiles.caller), 'utf8'),
			)
			const previousSymbols = project.symbols
			let readyCount = 0
			project.on('ready', () => {
				readyCount += 1
			})

			hooks.failBindUri = fixtureFiles.caller
			await project.onEditorConfigurationUpdate({ lint: { undeclaredSymbol: 'error' } })
			assert.equal(readyCount, 0)
			assert.equal(project.symbols, previousSymbols)
			assert.equal(project.isReady, true)
			assert.equal(project.bindingInProgressCount, 0)

			hooks.failBindUri = undefined
			await project.onEditorConfigurationUpdate({ lint: { undeclaredSymbol: 'error' } })
			assert.equal(readyCount, 1)
			assert.notEqual(project.symbols, previousSymbols)
			assert.equal(project.isReady, true)
		} finally {
			await project.close()
			await rm(cacheDir, { recursive: true, force: true })
		}
	})
})

describe('Project cache-backed documents (#1483)', () => {
	const VanillaRootUri = 'archive://vanilla-open/' as core.RootUriString
	const PlacedFeatureUri =
		'archive://vanilla-open/data/minecraft/worldgen/placed_feature/cache_open.json'
	const OriginalConfiguredFeatureUri =
		'archive://vanilla-open/data/minecraft/worldgen/configured_feature/cache_open_configured.json'
	const ChangedConfiguredFeatureUri =
		'archive://vanilla-open/data/minecraft/worldgen/configured_feature/cache_open_changed.json'
	const VanillaFixtureRoot = new URL('./fixture/vanilla-open/', import.meta.url)
	const PlacedFeatureFixture = new URL(
		'./fixture/vanilla-open/data/minecraft/worldgen/placed_feature/cache_open.json',
		import.meta.url,
	)
	const OriginalConfiguredFeatureFixture = new URL(
		'./fixture/vanilla-open/data/minecraft/worldgen/configured_feature/cache_open_configured.json',
		import.meta.url,
	)
	const ChangedConfiguredFeatureFixture = new URL(
		'./fixture/vanilla-open/data/minecraft/worldgen/configured_feature/cache_open_changed.json',
		import.meta.url,
	)
	const ArchiveFiles = new Map([
		[PlacedFeatureUri, PlacedFeatureFixture],
		[OriginalConfiguredFeatureUri, OriginalConfiguredFeatureFixture],
		[ChangedConfiguredFeatureUri, ChangedConfiguredFeatureFixture],
	])

	const initializeJavaEditionFixture: core.ProjectInitializer = (ctx) => {
		mcdoc.initialize(ctx)
		ctx.meta.registerUriBinder(je.binder.uriBinder)
		je.binder.registerUriBuilders(ctx.meta)
		json.getInitializer(je.binder.jeFileUriPredicate)(ctx)
		je.json.initialize(ctx)
		return { errorSource: '1.20.4', loadedVersion: '1.20.4' }
	}

	let cacheDir: string
	let cachedUri: string
	let placedFeatureContent: string
	let project: core.Project
	let projectDir: string

	beforeEach(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-vanilla-open-cache-'))
		projectDir = await mkdtemp(join(tmpdir(), 'spyglass-vanilla-open-project-'))
		placedFeatureContent = await readFile(PlacedFeatureFixture, 'utf8')
		project = new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
			defaultConfig: core.ConfigService.merge(core.VanillaConfig, {
				env: {
					dependencies: [core.fileUtil.ensureEndingSlash(VanillaFixtureRoot.toString())],
					exclude: [],
				},
			}),
			externals: NodeJsExternals,
			initializers: [initializeJavaEditionFixture],
			logger: core.Logger.noop(),
			projectRoots: [
				core.fileUtil.ensureEndingSlash(pathToFileURL(projectDir).toString()),
				VanillaRootUri,
			],
		})
		await project.init()
		await project.ready({ projectRootsWatcher: new FixtureWatcher(...ArchiveFiles.keys()) })

		project.fs.register(
			'archive:',
			{
				async hash(uri) {
					const fixture = ArchiveFiles.get(uri)
					assert.ok(fixture)
					return fixture.toString()
				},
				async readFile(uri) {
					const fixture = ArchiveFiles.get(uri)
					assert.ok(fixture)
					return readFile(fixture)
				},
				*listFiles() {
					yield* ArchiveFiles.keys()
				},
				*listRoots() {
					yield VanillaRootUri
				},
			},
			true,
		)

		const mapped = await project.fs.mapToDisk(PlacedFeatureUri)
		assert.ok(mapped?.startsWith(project.cacheRoot))
		cachedUri = mapped
	})

	afterEach(async () => {
		await project.close()
		await Promise.all([
			rm(cacheDir, { recursive: true, force: true }),
			rm(projectDir, { recursive: true, force: true }),
		])
	})

	it('rejects a direct archive URI as a client-managed document', async () => {
		await project.onDidOpen(PlacedFeatureUri, 'json', 1, placedFeatureContent)

		assert.equal(project.getClientManaged(PlacedFeatureUri), undefined)
		assert.equal(project.getClientManagedUri(PlacedFeatureUri), undefined)
	})

	it('reports cache-backed diagnostics through the physical client URI mapping', async () => {
		const diagnostics = new Promise<core.PosRangeLanguageError[]>((resolve) => {
			project.on('documentErrored', ({ errors, uri }) => {
				if (uri === PlacedFeatureUri) {
					resolve([...errors])
				}
			}, { once: true })
		})

		await project.onDidOpen(cachedUri, 'json', 1, '{')

		assert.ok((await diagnostics).length > 0)
		assert.equal(project.getClientManagedUri(PlacedFeatureUri), cachedUri)
		await project.onDidClose(cachedUri)
	})

	it('updates references on change and restores archive references on close', async () => {
		await project.onDidOpen(cachedUri, 'json', 1, placedFeatureContent)

		const original = project.symbols.lookup(
			'worldgen/configured_feature',
			['minecraft:cache_open_configured'],
		).symbol
		const changed = project.symbols.lookup(
			'worldgen/configured_feature',
			['minecraft:cache_open_changed'],
		).symbol
		assert.ok(original?.definition?.some(({ uri }) => uri === OriginalConfiguredFeatureUri))
		assert.ok(changed?.definition?.some(({ uri }) => uri === ChangedConfiguredFeatureUri))
		assert.ok(original.reference?.some(({ uri }) => uri === PlacedFeatureUri))

		const changedContent = placedFeatureContent.replace(
			'minecraft:cache_open_configured',
			'minecraft:cache_open_changed',
		)
		await project.onDidChange(cachedUri, [{ text: changedContent }], 2)

		assert.equal(original.reference?.some(({ uri }) => uri === PlacedFeatureUri), false)
		assert.ok(changed.reference?.some(({ uri }) => uri === PlacedFeatureUri))

		await project.onDidClose(cachedUri)

		assert.equal(project.getClientManaged(PlacedFeatureUri), undefined)
		assert.equal(project.getClientManagedUri(PlacedFeatureUri), undefined)
		assert.ok(original.reference?.some(({ uri }) => uri === PlacedFeatureUri))
		assert.equal(changed.reference?.some(({ uri }) => uri === PlacedFeatureUri), false)
	})
})
