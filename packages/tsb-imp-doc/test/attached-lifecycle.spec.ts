import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { getImpDocSymbolData, initialize as initializeImpDoc } from '../lib/index.js'
import { createServiceRuntime, type ServiceRuntime } from './contract-runtime.ts'

/**
 * `attach_define` mints the attached command's own definition site (real
 * consumer commands never set `usageType`, matching Phase 4-3c's Focus 3
 * design: attached-command definitions are the exception, not the rule).
 * Both commands bind into the plugin-local `attached_probe` resource-location
 * category, mirroring how `storage`/`function` categories already work.
 */
const Commands: je.dependency.McmetaCommands = {
	type: 'root',
	children: {
		attach_define: {
			type: 'literal',
			children: {
				target: {
					type: 'argument',
					parser: 'minecraft:resource_location',
					properties: { category: 'attached_probe', usageType: 'definition' },
					executable: true,
				},
			},
		},
		attach_use: {
			type: 'literal',
			children: {
				target: {
					type: 'argument',
					parser: 'minecraft:resource_location',
					properties: { category: 'attached_probe' },
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
	readonly #onReady: ((watcher: FixtureWatcher) => void) | undefined

	constructor(uris: readonly string[], onReady?: (watcher: FixtureWatcher) => void) {
		super()
		this.#onReady = onReady
		for (const uri of uris) {
			this.watchedFiles.add(uri)
		}
	}

	async ready(): Promise<void> {
		this.#onReady?.(this)
	}

	async close(): Promise<void> {}
}

function createConfig(): core.Config {
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

function createRuntimeProject(
	cacheDir: string,
	projectRoot: core.RootUriString,
): core.Project {
	return new core.Project({
		cacheRoot: core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
		defaultConfig: createConfig(),
		externals: NodeJsExternals,
		initializers: [async (ctx) => {
			ctx.meta.registerUriBinder(je.binder.uriBinder)
			je.mcf.initialize(ctx, Commands, '1.20.4')
			const impDoc = (await initializeImpDoc(ctx)) ?? {}
			return { ...impDoc, loadedVersion: '1.20.4', errorSource: '1.20.4' }
		}],
		logger: { error: () => {}, info: () => {}, log: () => {}, warn: () => {} },
		projectRoots: [projectRoot],
	})
}

// Resolve Windows 8.3 short names before converting fixture paths to URIs, matching
// `test/declaration-union.spec.ts`'s `createCanonicalTempDir` pattern: otherwise
// `pathToFileURL` encodes `~` as `%7E` while `UriStore` rebuilds the watched URI with
// a literal `~`, splitting cache and symbol keys in two.
async function createCanonicalTempDir(prefix: string): Promise<string> {
	return realpath(await mkdtemp(prefix))
}

async function writeRuntimeFixtureFile(
	projectRoot: string,
	relativePath: string,
	content: string,
): Promise<{ path: string; uri: string }> {
	const path = join(projectRoot, relativePath)
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
	return { path, uri: core.normalizeUri(pathToFileURL(path).toString()) }
}

const PackMcmeta =
	'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Attached lifecycle fixture"\n\t}\n}\n'

const OwnerContent = '#> attached:owner\n# @public\n\n#> Attached probe target\n# @private\n'
	+ '    attach_define attached:restricted_probe\n'

const OwnerPublicContent = '#> attached:owner\n# @public\n\n#> Attached probe target\n# @public\n'
	+ '    attach_define attached:restricted_probe\n'

const OwnerNoAttachedContent = '#> attached:owner\n# @public\n\nsay no attached command anymore\n'

const CallerContent = '#> other:caller\n# @public\n\nattach_use attached:restricted_probe\n'

describe('IMP-Doc attached binder runtime (P4-3c happy path)', () => {
	let runtime: ServiceRuntime<'owner' | 'caller'> | undefined

	before(async () => {
		runtime = await createServiceRuntime({
			fixture: 'attached-lifecycle-project',
			files: {
				owner: 'data/attached/functions/owner.mcfunction',
				caller: 'data/other/functions/caller.mcfunction',
			},
			commands: Commands,
			// `createServiceRuntime`'s own default config only enables
			// `impDocContractCheck`; the denied-caller test needs `impDocPrivate` on.
			defaultConfig: createConfig(),
			tempPrefix: 'spyglass-imp-doc-attached-',
		})
	})

	after(async () => {
		await runtime?.close()
	})

	it("stamps the attached command's own definition as a declaration-visibility entry", () => {
		assert.ok(runtime)
		const symbol = runtime.service.project.symbols.lookup(
			'attached_probe',
			['attached:restricted_probe'],
		).symbol
		assert.ok(symbol, 'the attach_define target must be bound as attached_probe')
		const data = getImpDocSymbolData(symbol.data)
		assert.equal(data?.declarations?.length, 1)
		const entry = data!.declarations![0]!
		assert.equal(entry.uri, runtime.uris.owner)
		assert.equal(entry.owner, 'attached:owner')
		assert.equal(entry.visibility.type, 'private')
	})

	it('wires node.symbol on the attached candidate so hover / definition / references work', () => {
		assert.ok(runtime)
		const ownerState = runtime.states.owner
		const nameStart = ownerState.content.indexOf('attached:restricted_probe')
		assert.notEqual(nameStart, -1)
		const node = core.AstNode.findDeepestChild({
			node: ownerState.node,
			needle: nameStart + 1,
			predicate: () => true,
		})
		let head: core.AstNode | undefined = node as core.AstNode | undefined
		while (head && !head.symbol) {
			head = head.parent
		}
		assert.ok(head?.symbol)
		assert.equal(head.symbol.category, 'attached_probe')
	})

	it('reports impDocPrivate for a denied caller referencing the attached target', () => {
		assert.ok(runtime)
		const callerState = runtime.states.caller
		const errors = callerState.node.linterErrors ?? []
		assert.equal(errors.length, 1)
		assert.match(errors[0]!.message, /impDocPrivate/)
		assert.match(errors[0]!.message, /attached:restricted_probe/)
		assert.match(errors[0]!.message, /attached:owner/)
	})
})

describe('IMP-Doc attached binder URI lifecycle (P4-3c edit/delete/warm reload)', () => {
	it('replaces (not duplicates) the entry when the owning document is re-bound after an edit', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-attached-edit-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-attached-edit-cache-'),
		)
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(projectRoot, 'pack.mcmeta', PackMcmeta)
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/attached/functions/owner.mcfunction',
				OwnerContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			await project.ready({
				projectRootsWatcher: new FixtureWatcher([pack.uri, owner.uri]),
			})
			// `onDidChange` only affects client-managed documents; open the file
			// first so the later edit actually reaches a rebind (matching
			// `declaration-union.spec.ts`'s "URI purge across a warm cache reload"
			// / implicit-owner-lint edit tests).
			await project.onDidOpen(owner.uri, 'mcfunction', 1, OwnerContent)

			const before_ = getImpDocSymbolData(
				project.symbols.lookup('attached_probe', ['attached:restricted_probe']).symbol?.data,
			)
			assert.equal(before_?.declarations?.length, 1)
			assert.equal(before_?.declarations?.[0]?.visibility.type, 'private')

			// Re-bind the same URI at the same attached-command range (only the
			// annotation changes): the (uri, range) upsert in `stampVisibility`
			// must replace the stale entry, not accumulate a second one.
			await project.onDidChange(owner.uri, [{ text: OwnerPublicContent }], 2)

			const afterEdit = getImpDocSymbolData(
				project.symbols.lookup('attached_probe', ['attached:restricted_probe']).symbol?.data,
			)
			assert.equal(afterEdit?.declarations?.length, 1)
			assert.equal(afterEdit?.declarations?.[0]?.visibility.type, 'public')
		} finally {
			await project?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('purges the entry when the attached command is edited away', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-attached-remove-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-attached-remove-cache-'),
		)
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(projectRoot, 'pack.mcmeta', PackMcmeta)
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/attached/functions/owner.mcfunction',
				OwnerContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			await project.ready({
				projectRootsWatcher: new FixtureWatcher([pack.uri, owner.uri]),
			})
			await project.onDidOpen(owner.uri, 'mcfunction', 1, OwnerContent)
			assert.ok(project.symbols.lookup('attached_probe', ['attached:restricted_probe']).symbol)

			await project.onDidChange(owner.uri, [{ text: OwnerNoAttachedContent }], 2)

			const symbol =
				project.symbols.lookup('attached_probe', ['attached:restricted_probe']).symbol
			const data = getImpDocSymbolData(symbol?.data)
			assert.equal(data?.declarations, undefined)
		} finally {
			await project?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('purges the entry across a warm cache reload after the owning file is deleted', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-attached-delete-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-attached-delete-cache-'),
		)
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(projectRoot, 'pack.mcmeta', PackMcmeta)
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/attached/functions/owner.mcfunction',
				OwnerContent,
			)
			const caller = await writeRuntimeFixtureFile(
				projectRoot,
				'data/other/functions/caller.mcfunction',
				CallerContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, owner.uri, caller.uri]

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			assert.equal(
				getImpDocSymbolData(
					first.symbols.lookup('attached_probe', ['attached:restricted_probe']).symbol?.data,
				)?.declarations?.length,
				1,
			)
			await first.close()
			first = undefined

			await rm(owner.path, { force: true })

			second = createRuntimeProject(cacheDir, projectRootUri)
			await second.init()
			await second.ready({
				projectRootsWatcher: new FixtureWatcher(
					[pack.uri, caller.uri],
					watcher => watcher.emit('unlink', owner.uri),
				),
			})

			const symbol =
				second.symbols.lookup('attached_probe', ['attached:restricted_probe']).symbol
			// A restricted-only symbol with zero surviving declaration entries is
			// pruned entirely: no dangling `impDoc` metadata across the reload.
			assert.equal(getImpDocSymbolData(symbol?.data)?.declarations, undefined)
		} finally {
			await first?.close()
			await second?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})
