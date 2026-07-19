import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	getImpDocSymbolData,
	initialize as initializeImpDoc,
	matchesAnyVisibility,
	stampVisibility,
} from '../lib/index.js'
import { visibilityConflict } from '../lib/linter/conflict.js'

// Canonicalize fixture URIs with core.normalizeUri (lowercases Windows drive letters,
// like UriStore does for watched files) so that projectRoots, watcher entries, and
// assertions all compare the same URI form. See core/common/util.ts#normalizeUriPathname.
const FixtureRoot = core.fileUtil.ensureEndingSlash(
	core.normalizeUri(new URL('./runtime/union-project/', import.meta.url).toString()),
)

const Files = {
	index: './runtime/union-project/data/owner/functions/_index.d.mcfunction',
	ajRemove: './runtime/union-project/data/aj/functions/remove.mcfunction',
	caller: './runtime/union-project/data/external/functions/caller.mcfunction',
	secondOwner: './runtime/union-project/data/external/functions/second_owner.mcfunction',
	denied: './runtime/union-project/data/other/functions/denied.mcfunction',
	internalFirst: './runtime/union-project/data/internal/functions/first_owner.mcfunction',
	internalSecond: './runtime/union-project/data/internal/functions/second_owner.mcfunction',
} as const

type UnionFile = keyof typeof Files

const FileUris = Object.fromEntries(
	Object.entries(Files).map(([key, path]) => [
		key,
		core.normalizeUri(new URL(path, import.meta.url).toString()),
	]),
) as Record<UnionFile, string>

const PackMcmetaUri = core.normalizeUri(
	new URL('./runtime/union-project/pack.mcmeta', import.meta.url).toString(),
)

type UnionState = core.DocAndNode & { content: string }

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

const initializeRuntime: core.ProjectInitializer = async (ctx) => {
	ctx.meta.registerUriBinder(je.binder.uriBinder)
	je.mcf.initialize(ctx, Commands, '1.20.4')
	const impDoc = (await initializeImpDoc(ctx)) ?? {}
	return { ...impDoc, loadedVersion: '1.20.4', errorSource: '1.20.4' }
}

class FixtureWatcher extends core.EventDispatcher<core.FileWatcherEventMap>
	implements core.FileWatcher
{
	readonly watchedFiles = new core.UriStore()
	readonly #onReady: ((watcher: FixtureWatcher) => void) | undefined

	constructor(
		uris: readonly string[],
		onReady?: (watcher: FixtureWatcher) => void,
	) {
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
	lint['impDocPrivate'] = 'error'
	lint['impDocVisibilityConflict'] = 'warning'
	return config
}

function createRuntimeProject(
	cacheDir: string,
	projectRoot: core.RootUriString,
	initializers: readonly core.ProjectInitializer[] = [initializeRuntime],
	fs?: core.FileService,
): core.Project {
	return new core.Project({
		cacheRoot: core.fileUtil.ensureEndingSlash(
			pathToFileURL(cacheDir).toString(),
		),
		defaultConfig: createConfig(),
		externals: NodeJsExternals,
		fs,
		initializers,
		logger: {
			error: () => {},
			info: () => {},
			log: () => {},
			warn: () => {},
		},
		projectRoots: [projectRoot],
	})
}

function createArchiveFixtureFileService(
	cacheDir: string,
	archiveRoot: core.RootUriString,
	files: ReadonlyMap<string, string>,
): core.FileService {
	const fs = core.FileService.create(
		NodeJsExternals,
		core.fileUtil.ensureEndingSlash(pathToFileURL(cacheDir).toString()),
	)
	fs.register('archive:', {
		async hash(uri) {
			if (uri === archiveRoot) {
				return core.getSha1([...files.values()].join('\0'))
			}
			const content = files.get(uri)
			assert.ok(content !== undefined)
			return core.getSha1(content)
		},
		async readFile(uri) {
			const content = files.get(uri)
			assert.ok(content !== undefined)
			return new TextEncoder().encode(content)
		},
		*listFiles() {
			yield* files.keys()
		},
		*listRoots() {
			yield archiveRoot
		},
	})
	// Project.ready() installs its dependency-backed archive supporter. Keep this
	// in-memory fixture supporter registered instead.
	const register = fs.register.bind(fs)
	fs.register = (protocol, supporter, force) => {
		if (protocol !== 'archive:') {
			register(protocol, supporter, force)
		}
	}
	return fs
}

async function createCanonicalTempDir(prefix: string): Promise<string> {
	// Resolve Windows 8.3 short names before converting fixture paths to URIs.
	// Otherwise pathToFileURL encodes `~` as `%7E`, while UriStore rebuilds the
	// watched URI with a literal `~`, splitting cache and symbol keys in two.
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
	return {
		path,
		uri: core.normalizeUri(pathToFileURL(path).toString()),
	}
}

describe('IMP-Doc declaration union runtime (P4-2b v3 parity)', () => {
	const states = new Map<UnionFile, UnionState>()
	let project: core.Project | undefined
	let cacheDir: string | undefined

	before(async () => {
		cacheDir = await createCanonicalTempDir(join(tmpdir(), 'spyglass-imp-doc-union-'))
		const watcher = new FixtureWatcher([
			PackMcmetaUri,
			...Object.values(FileUris),
		])

		project = createRuntimeProject(cacheDir, FixtureRoot)

		await project.init()
		await project.ready({ projectRootsWatcher: watcher })

		for (const file of Object.keys(FileUris) as UnionFile[]) {
			const uri = FileUris[file]
			const content = await readFile(fileURLToPath(uri), 'utf8')
			await project.onDidOpen(uri, 'mcfunction', 1, content)
			const result = project.getClientManaged(uri)
			assert.ok(result, `${file} should have been opened and checked`)
			states.set(file, { ...result, content })
		}
	})

	after(async () => {
		await project?.close()
		if (cacheDir) {
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	function getState(file: UnionFile): UnionState {
		const state = states.get(file)
		assert.ok(state, `${file} should have been opened and checked`)
		return state
	}

	it('allows a caller admitted only by its own local #declare (any-match union)', () => {
		// `_index.d` restricts aj:remove to owner:**, but the caller file declares
		// the same function with `@within function external:**`. v3 keeps every
		// declaration position's visibility and ORs them, so the call is legal.
		assert.deepEqual(getState('caller').node.linterErrors ?? [], [])
	})

	it('still reports a caller admitted by no declaration', () => {
		const errors = getState('denied').node.linterErrors ?? []
		assert.equal(errors.length, 1)
		assert.equal(errors[0]?.severity, core.ErrorSeverity.Error)
		assert.match(errors[0]!.message, /impDocPrivate/)
		assert.match(errors[0]!.message, /aj:remove/)
		assert.match(errors[0]!.message, /other:denied/)
	})

	it('warns on private-owner and public-restricted conflicts only in the canonical declaring file', () => {
		const errors = getState('secondOwner').node.linterErrors ?? []
		assert.equal(errors.length, 2)
		for (const error of errors) {
			assert.equal(error.severity, core.ErrorSeverity.Warning)
			assert.match(error.message, /impDocVisibilityConflict/)
		}
		assert.match(
			errors[0]!.message,
			/private to “external:second_owner” here and private to “owner:_index\.d”/,
		)
		assert.match(errors[1]!.message, /restricted here but public/)
	})

	it('does not duplicate conflict diagnostics in the counterpart declaring file', () => {
		const errors = getState('index').node.linterErrors ?? []
		assert.deepEqual(errors, [])
	})

	it('does not warn on same-owner private duplicates, within unions, or internal unions', () => {
		// dup:data is declared @private twice by the same owner and aj:remove has
		// two different @within declarations. internal:shared adds two @internal
		// declarations in the same namespace; none may produce a conflict.
		// The exact-2 assertions above already exclude them, and the headerless
		// aj target plus the caller-local declare must stay conflict-free too.
		assert.deepEqual(getState('ajRemove').node.linterErrors ?? [], [])
		assert.deepEqual(getState('caller').node.linterErrors ?? [], [])
		assert.deepEqual(getState('internalFirst').node.linterErrors ?? [], [])
		assert.deepEqual(getState('internalSecond').node.linterErrors ?? [], [])
	})
})

describe('IMP-Doc conflict owner implicit lint', () => {
	it('publishes and clears a canonical-owner warning while that owner remains unopened', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-conflict-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-conflict-cache-'),
		)
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Implicit conflict lint fixture"\n\t}\n}\n',
			)
			const ownerContent = '#> a:owner\n# @public\n\n'
				+ '#> Canonical declaration\n# @public\n#declare storage shared:data\n'
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:data\n'
			const resolvedSideContent = '#> b:side\n# @public\n\n'
				+ '#> Resolved declaration\n# @public\n#declare storage shared:data\n'
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				ownerContent,
			)
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)

			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			await project.ready({
				projectRootsWatcher: new FixtureWatcher([pack.uri, owner.uri, side.uri]),
			})
			assert.equal(project.getClientManaged(owner.uri), undefined)

			await project.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			assert.equal(project.getClientManaged(owner.uri), undefined)
			const warning = project.cacheService.errors[owner.uri] ?? []
			assert.equal(warning.length, 1)
			assert.equal(warning[0]?.severity, core.ErrorSeverity.Warning)
			assert.match(warning[0]?.message ?? '', /impDocVisibilityConflict/)

			await project.onDidChange(side.uri, [{ text: resolvedSideContent }], 2)
			assert.equal(project.getClientManaged(owner.uri), undefined)
			assert.deepEqual(project.cacheService.errors[owner.uri] ?? [], [])
		} finally {
			await project?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc declaration URI purge across a warm cache reload', () => {
	it('removes the final declaration entries after their source document changes', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-union-project-'),
		)
		const cacheDir = await createCanonicalTempDir(join(tmpdir(), 'spyglass-imp-doc-union-cache-'))
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "URI purge cache fixture"\n\t}\n}\n',
			)
			const source = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/declarations.mcfunction',
				'#> a:declarations\n# @public\n\n#> Visibility to remove\n# @private\n#declare storage cache:target\n\n#> Conflict side to remove\n# @private\n#declare storage cache:conflict\n',
			)
			const retained = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/declarations.mcfunction',
				'#> b:declarations\n# @public\n\n#> Retained visibility\n# @within function b:**\n#declare storage cache:target\n\n#> Retained conflict side\n# @public\n#declare storage cache:conflict\n',
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, source.uri, retained.uri]

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			const firstTarget = first.symbols.lookup('storage', ['cache:target']).symbol
			assert.ok(firstTarget)
			assert.deepEqual(
				getImpDocSymbolData(firstTarget.data)?.declarations?.map(entry => entry.uri),
				[source.uri, retained.uri],
			)
			assert.match(firstTarget.desc ?? '', /Visibility to remove/)
			await first.close()
			first = undefined

			await writeFile(
				source.path,
				'#> a:declarations\n# @public\n\n# All #declare directives in this URI were removed.\n',
			)

			second = createRuntimeProject(cacheDir, projectRootUri)
			await second.init()
			await second.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })

			const targetAfterReload = second.symbols.lookup('storage', ['cache:target']).symbol
			assert.ok(targetAfterReload)
			const targetData = getImpDocSymbolData(targetAfterReload.data)
			assert.deepEqual(
				targetData?.declarations?.map(entry => entry.uri),
				[retained.uri],
			)
			assert.equal(matchesAnyVisibility(targetData, 'a:declarations'), false)
			assert.equal(matchesAnyVisibility(targetData, 'b:caller'), true)
			assert.equal(targetAfterReload.visibility, 3)
			assert.deepEqual(targetAfterReload.visibilityRestriction, ['^b:.{0,}$'])
			assert.match(targetAfterReload.desc ?? '', /Retained visibility/)
			assert.doesNotMatch(targetAfterReload.desc ?? '', /Visibility to remove/)

			const conflictAfterReload = second.symbols.lookup('storage', ['cache:conflict']).symbol
			assert.ok(conflictAfterReload)
			assert.deepEqual(
				getImpDocSymbolData(conflictAfterReload.data)?.declarations?.map(entry => entry.uri),
				[retained.uri],
			)

			const retainedContent = await readFile(retained.path, 'utf8')
			await second.onDidOpen(retained.uri, 'mcfunction', 1, retainedContent)
			const retainedState = second.getClientManaged(retained.uri)
			assert.ok(retainedState)
			assert.deepEqual(
				(retainedState.node.linterErrors ?? []).filter(error =>
					error.message.includes('impDocVisibilityConflict')
				),
				[],
			)
		} finally {
			await first?.close()
			await second?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc function header purge on file deletion', () => {
	it('purges a deleted header and settles its new owner before warm READY', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-header-purge-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-header-purge-cache-'),
		)
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Header purge fixture"\n\t}\n}\n',
			)
			const header = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/target.mcfunction',
				'#> a:target\n# @public\n\nbadcommand target\n',
			)
			const declaringContent = '#> b:decl\n# @public\n\n'
				+ '#> Restricted declaration\n# @private\n#declare function a:target\n'
			const declaring = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/decl.mcfunction',
				declaringContent,
			)
			const otherDeclaring = await writeRuntimeFixtureFile(
				projectRoot,
				'data/c/functions/decl.mcfunction',
				'#> c:decl\n# @public\n\n'
					+ '#> Other restricted declaration\n# @private\n#declare function a:target\n',
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({
				projectRootsWatcher: new FixtureWatcher([
					pack.uri,
					header.uri,
					declaring.uri,
					otherDeclaring.uri,
				]),
			})
			const before = getImpDocSymbolData(
				first.symbols.lookup('function', ['a:target']).symbol?.data,
			)
			assert.equal(before?.headerUri, header.uri)
			// The @public header keeps the union open for any caller.
			assert.equal(matchesAnyVisibility(before, 'other:caller'), true)
			// Linting a declaration queues the canonical header owner. Persist both
			// its parser error and the public/private conflict as stale diagnostics.
			await first.onDidOpen(declaring.uri, 'mcfunction', 1, declaringContent)
			const seededHeaderErrors = first.cacheService.errors[header.uri] ?? []
			assert.ok(seededHeaderErrors.length > 0)
			assert.ok(
				seededHeaderErrors.some(error => error.message.includes('impDocVisibilityConflict')),
			)
			await first.close()
			first = undefined

			await rm(header.path, { force: true })

			second = createRuntimeProject(cacheDir, projectRootUri)
			const secondProject = second
			await secondProject.init()
			let readyObserved = false
			let readyHeaderUri: string | undefined
			let readyHeaderErrors: readonly core.PosRangeLanguageError[] | undefined
			let readyOwnerErrors: readonly core.PosRangeLanguageError[] | undefined
			let headerRemovalCount = 0
			secondProject.on('ready', () => {
				readyObserved = true
				const readySymbol = secondProject.symbols.lookup(
					'function',
					['a:target'],
				).symbol
				readyHeaderUri = getImpDocSymbolData(readySymbol?.data)?.headerUri
				readyHeaderErrors = [...(secondProject.cacheService.errors[header.uri] ?? [])]
				readyOwnerErrors = [
					...(secondProject.cacheService.errors[declaring.uri] ?? []),
				]
			}).on('documentRemoved', ({ uri }) => {
				if (uri === header.uri) {
					headerRemovalCount += 1
				}
			})
			await secondProject.ready({
				projectRootsWatcher: new FixtureWatcher([
					pack.uri,
					declaring.uri,
					otherDeclaring.uri,
				], watcher => watcher.emit('unlink', header.uri)),
			})
			// Fence on the unlink lifecycle task queued by watcher.ready().
			await secondProject.onDidClose(declaring.uri)

			assert.equal(readyObserved, true)
			assert.equal(headerRemovalCount, 1)
			assert.equal(readyHeaderUri, undefined)
			assert.deepEqual(readyHeaderErrors, [])
			assert.ok(
				readyOwnerErrors?.some(error =>
					/private to “b:decl” here and private to “c:decl”/.test(error.message)
				),
				'the surviving declaration owner must be linted before READY',
			)

			const symbol = secondProject.symbols.lookup('function', ['a:target']).symbol
			assert.ok(symbol)
			const data = getImpDocSymbolData(symbol.data)
			assert.equal(data?.visibility, undefined)
			assert.equal(data?.headerUri, undefined)
			assert.deepEqual(
				data?.declarations?.map(entry => entry.uri),
				[declaring.uri, otherDeclaring.uri],
			)
			// Without the header purge the stale @public entry would keep the
			// union public for every caller.
			assert.equal(matchesAnyVisibility(data, 'other:caller'), false)
			assert.equal(matchesAnyVisibility(data, 'b:decl'), true)
			assert.equal(matchesAnyVisibility(data, 'c:decl'), true)
			assert.equal(symbol.visibility, 3)
		} finally {
			await first?.close()
			await second?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc implicit owner lint stage preservation', () => {
	it('keeps binder diagnostics when a conflict republishes an unopened owner', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-implicit-stage-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-implicit-stage-cache-'),
		)
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Implicit lint stage fixture"\n\t}\n}\n',
			)
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				'#> a:owner\n# @public\n\n'
					+ '#> Canonical declaration\n# @public\n#declare storage shared:data\n\n'
					+ '#> Broken visibility\n# @within\n#declare storage broken:data\n',
			)
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:data\n'
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)

			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			await project.ready({
				projectRootsWatcher: new FixtureWatcher([pack.uri, owner.uri, side.uri]),
			})
			const binderMessage = /@within requires a path pattern/
			const initial = project.cacheService.errors[owner.uri] ?? []
			assert.ok(initial.some(error => binderMessage.test(error.message)))

			await project.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			assert.equal(project.getClientManaged(owner.uri), undefined)
			const republished = project.cacheService.errors[owner.uri] ?? []
			assert.ok(
				republished.some(error => error.message.includes('impDocVisibilityConflict')),
				'the implicit lint must publish the canonical conflict warning',
			)
			assert.ok(
				republished.some(error => binderMessage.test(error.message)),
				'the implicit lint must not drop previously published binder diagnostics',
			)
		} finally {
			await project?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc warm start queued lint vs staged diagnostics ordering', () => {
	it('does not roll queued owner diagnostics back to stale cache errors', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-warm-order-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-warm-order-cache-'),
		)
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Warm order fixture"\n\t}\n}\n',
			)
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				'#> a:owner\n# @public\n\n'
					+ '#> Canonical declaration\n# @public\n#declare storage shared:data\n',
			)
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:data\n'
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, owner.uri, side.uri]

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			// Seed the cached diagnostics with the canonical-owner conflict warning.
			await first.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			const seeded = first.cacheService.errors[owner.uri] ?? []
			assert.ok(seeded.some(error => error.message.includes('impDocVisibilityConflict')))
			await first.close()
			first = undefined

			// Resolve the conflict while no project is running.
			await writeFile(
				side.path,
				'#> b:side\n# @public\n\n'
					+ '#> Resolved declaration\n# @public\n#declare storage shared:data\n',
			)

			second = createRuntimeProject(cacheDir, projectRootUri)
			await second.init()
			await second.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })

			// The queued implicit lint of the unchanged owner must win over the
			// stale staged cache diagnostics published during the warm start.
			assert.deepEqual(
				(second.cacheService.errors[owner.uri] ?? []).filter(error =>
					error.message.includes('impDocVisibilityConflict')
				),
				[],
			)
		} finally {
			await first?.close()
			await second?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc conflict ownership handoff on header file deletion', () => {
	it('queues the surviving declaration owner and publishes the conflict there', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-owner-handoff-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-owner-handoff-cache-'),
		)
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Owner handoff fixture"\n\t}\n}\n',
			)
			const header = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/target.mcfunction',
				'#> a:target\n# @public\n',
			)
			const first = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/first.mcfunction',
				'#> b:first\n# @public\n\n'
					+ '#> First private declaration\n# @private\n#declare function a:target\n',
			)
			const second = await writeRuntimeFixtureFile(
				projectRoot,
				'data/c/functions/second.mcfunction',
				'#> c:second\n# @public\n\n'
					+ '#> Second private declaration\n# @private\n#declare function a:target\n',
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watcher = new FixtureWatcher([pack.uri, header.uri, first.uri, second.uri])

			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			await project.ready({ projectRootsWatcher: watcher })
			// The initial scan is bind-only, so no document owns the conflict yet.
			assert.deepEqual(
				(project.cacheService.errors[first.uri] ?? []).filter(error =>
					error.message.includes('impDocVisibilityConflict')
				),
				[],
			)

			await rm(header.path, { force: true })
			watcher.emit('unlink', header.uri)
			// The fileDeleted lifecycle operation is enqueued behind the watcher
			// event; fence on another lifecycle operation before asserting.
			await project.onDidClose(header.uri)

			// With the header (= previous canonical owner) gone, the surviving
			// first declaration document must be queued and publish the
			// private-owner conflict of the remaining declarations.
			const republished = project.cacheService.errors[first.uri] ?? []
			assert.ok(
				republished.some(error =>
					error.message.includes('impDocVisibilityConflict')
					&& /private to “b:first” here and private to “c:second”/.test(error.message)
				),
				'the surviving declaration owner must publish the conflict',
			)
			assert.deepEqual(project.cacheService.errors[header.uri] ?? [], [])
		} finally {
			await project?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc implicit lint checker preservation for closed cache documents', () => {
	it('keeps checker diagnostics when a queued lint republishes a closed cache document', async () => {
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-checked-cache-'),
		)
		// Place the project inside the cache root so its documents take the
		// cache-URI restore path (bind + check) in onDidClose.
		const projectRoot = join(cacheDir, 'project')
		await mkdir(projectRoot, { recursive: true })
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Checked cache doc fixture"\n\t}\n}\n',
			)
			// The mismatched header ID produces a checker-stage diagnostic.
			const ownerContent = '#> a:mismatch\n# @public\n\n'
				+ '#> Canonical declaration\n# @public\n#declare storage shared:data\n'
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:data\n'
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				ownerContent,
			)
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)

			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			await project.ready({
				projectRootsWatcher: new FixtureWatcher([pack.uri, owner.uri, side.uri]),
			})

			const checkerMessage = /Expected function ID/
			await project.onDidOpen(owner.uri, 'mcfunction', 1, ownerContent)
			await project.onDidClose(owner.uri)
			const closed = project.cacheService.errors[owner.uri] ?? []
			assert.ok(
				closed.some(error => checkerMessage.test(error.message)),
				'the closed cache document must keep its checker diagnostics published',
			)

			// Opening the conflicting side queues an implicit lint of the owner.
			await project.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			assert.equal(project.getClientManaged(owner.uri), undefined)
			const republished = project.cacheService.errors[owner.uri] ?? []
			assert.ok(
				republished.some(error => error.message.includes('impDocVisibilityConflict')),
				'the implicit lint must publish the canonical conflict warning',
			)
			assert.ok(
				republished.some(error => checkerMessage.test(error.message)),
				'the implicit lint must not drop the closed document checker diagnostics',
			)
		} finally {
			await project?.close()
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('restores checker preservation from a persisted warm cache', async () => {
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-checked-warm-cache-'),
		)
		const projectRoot = join(cacheDir, 'project')
		await mkdir(projectRoot, { recursive: true })
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Checked warm cache fixture"\n\t}\n}\n',
			)
			const ownerContent = '#> a:mismatch\n# @public\n\n'
				+ '#> Canonical declaration\n# @public\n#declare storage shared:warm_data\n'
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:warm_data\n'
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				ownerContent,
			)
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, owner.uri, side.uri]
			const checkerMessage = /Expected function ID/

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			await first.onDidOpen(owner.uri, 'mcfunction', 1, ownerContent)
			await first.onDidClose(owner.uri)
			assert.ok(
				(first.cacheService.errors[owner.uri] ?? []).some(error =>
					checkerMessage.test(error.message)
				),
			)
			await first.close()
			first = undefined

			second = createRuntimeProject(cacheDir, projectRootUri)
			await second.init()
			await second.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			assert.ok(
				(second.cacheService.errors[owner.uri] ?? []).some(error =>
					checkerMessage.test(error.message)
				),
				'the checker diagnostic must be restored from disk',
			)

			await second.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			assert.equal(second.getClientManaged(owner.uri), undefined)
			const republished = second.cacheService.errors[owner.uri] ?? []
			assert.ok(
				republished.some(error => error.message.includes('impDocVisibilityConflict')),
				'the warm-start implicit lint must republish the conflict warning',
			)
			assert.ok(
				republished.some(error => checkerMessage.test(error.message)),
				'the warm-start implicit lint must preserve the restored checker diagnostic',
			)
		} finally {
			await first?.close()
			await second?.close()
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('restores checker preservation for an archive document from a warm cache', async () => {
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-checked-archive-cache-'),
		)
		const projectRoot = join(cacheDir, 'project')
		await mkdir(projectRoot, { recursive: true })
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Checked archive cache fixture"\n\t}\n}\n',
			)
			const ownerContent = '#> a:mismatch\n# @public\n\n'
				+ '#> Canonical declaration\n# @public\n#declare storage shared:archive_data\n'
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Compatible declaration\n# @public\n#declare storage shared:archive_data\n'
			const conflictingSideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:archive_data\n'
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const archiveRoot = 'archive://imp-doc-checker/' as core.RootUriString
			const ownerUri = `${archiveRoot}data/a/functions/owner.mcfunction`
			const archiveFiles = new Map([[ownerUri, ownerContent]])
			const watchedUris = [pack.uri, side.uri]
			const checkerMessage = /Expected function ID/
			const createProject = () =>
				createRuntimeProject(
					cacheDir,
					projectRootUri,
					[initializeRuntime],
					createArchiveFixtureFileService(cacheDir, archiveRoot, archiveFiles),
				)

			first = createProject()
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			const mappedOwnerUri = await first.fs.mapToDisk(ownerUri)
			assert.ok(mappedOwnerUri)
			assert.ok(mappedOwnerUri.startsWith(first.cacheRoot))
			await first.onDidOpen(mappedOwnerUri, 'mcfunction', 1, ownerContent)
			await first.onDidClose(mappedOwnerUri)
			const closed = first.cacheService.errors[ownerUri] ?? []
			assert.ok(
				closed.some(error => checkerMessage.test(error.message)),
				'the closed archive document must publish its checker diagnostic',
			)
			assert.equal(
				closed.some(error => error.message.includes('impDocVisibilityConflict')),
				false,
			)
			await first.close()
			first = undefined

			second = createProject()
			await second.init()
			await second.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			assert.ok(
				(second.cacheService.errors[ownerUri] ?? []).some(error =>
					checkerMessage.test(error.message)
				),
				'the archive checker diagnostic must be restored from disk',
			)

			await second.onDidOpen(side.uri, 'mcfunction', 1, conflictingSideContent)
			assert.equal(second.getClientManaged(ownerUri), undefined)
			const republished = second.cacheService.errors[ownerUri] ?? []
			assert.ok(
				republished.some(error => error.message.includes('impDocVisibilityConflict')),
				'the warm-start implicit lint must publish the archive conflict warning',
			)
			assert.ok(
				republished.some(error => checkerMessage.test(error.message)),
				'the warm-start implicit lint must preserve the archive checker diagnostic',
			)
		} finally {
			await first?.close()
			await second?.close()
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('restores checker preservation when a rebuild transaction rolls back', async () => {
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-checked-rollback-cache-'),
		)
		const projectRoot = join(cacheDir, 'project')
		await mkdir(projectRoot, { recursive: true })
		let project: core.Project | undefined
		let contextGeneration = 'before'
		let failRegistrar = false
		const initializeRollbackFixture: core.ProjectInitializer = async (ctx) => {
			const runtimeContext = await initializeRuntime(ctx)
			ctx.meta.registerSymbolRegistrar('checked-cache-rollback', {
				checksum: contextGeneration,
				registrar: () => {
					if (failRegistrar) {
						throw new Error('Injected checked cache registrar failure')
					}
				},
			})
			return { ...runtimeContext, checkedCacheGeneration: contextGeneration }
		}
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Checked rollback fixture"\n\t}\n}\n',
			)
			const ownerContent = '#> a:mismatch\n# @public\n\n'
				+ '#> Canonical declaration\n# @public\n#declare storage shared:rollback_data\n'
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:rollback_data\n'
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				ownerContent,
			)
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, owner.uri, side.uri]
			const checkerMessage = /Expected function ID/

			project = createRuntimeProject(
				cacheDir,
				projectRootUri,
				[initializeRollbackFixture],
			)
			await project.init()
			await project.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			await project.onDidOpen(owner.uri, 'mcfunction', 1, ownerContent)
			await project.onDidClose(owner.uri)
			assert.ok(
				(project.cacheService.errors[owner.uri] ?? []).some(error =>
					checkerMessage.test(error.message)
				),
			)

			contextGeneration = 'after'
			failRegistrar = true
			await assert.rejects(
				project.reinitialize(),
				/Injected checked cache registrar failure/,
			)

			await project.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			assert.equal(project.getClientManaged(owner.uri), undefined)
			const republished = project.cacheService.errors[owner.uri] ?? []
			assert.ok(
				republished.some(error => error.message.includes('impDocVisibilityConflict')),
				'the post-rollback implicit lint must republish the conflict warning',
			)
			assert.ok(
				republished.some(error => checkerMessage.test(error.message)),
				'the rollback must restore checker provenance with cached diagnostics',
			)
		} finally {
			failRegistrar = false
			await project?.close()
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc ready event vs queued lint flush ordering', () => {
	it('emits ready only after queued warm-start lints have settled', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-ready-order-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-ready-order-cache-'),
		)
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Ready order fixture"\n\t}\n}\n',
			)
			const owner = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/owner.mcfunction',
				'#> a:owner\n# @public\n\n'
					+ '#> Canonical declaration\n# @public\n#declare storage shared:data\n',
			)
			const sideContent = '#> b:side\n# @public\n\n'
				+ '#> Conflicting declaration\n# @private\n#declare storage shared:data\n'
			const side = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/side.mcfunction',
				sideContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, owner.uri, side.uri]

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			// Seed the cached diagnostics with the canonical-owner conflict warning.
			await first.onDidOpen(side.uri, 'mcfunction', 1, sideContent)
			const seeded = first.cacheService.errors[owner.uri] ?? []
			assert.ok(seeded.some(error => error.message.includes('impDocVisibilityConflict')))
			await first.close()
			first = undefined

			// Resolve the conflict while no project is running.
			await writeFile(
				side.path,
				'#> b:side\n# @public\n\n'
					+ '#> Resolved declaration\n# @public\n#declare storage shared:data\n',
			)

			second = createRuntimeProject(cacheDir, projectRootUri)
			const secondProject = second
			await secondProject.init()
			let readySnapshot: core.PosRangeLanguageError[] | undefined
			secondProject.on('ready', () => {
				readySnapshot = [...(secondProject.cacheService.errors[owner.uri] ?? [])]
			})
			await secondProject.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })

			// The queued implicit lint of the unchanged owner must have settled
			// before ready fired; its listeners never observe the stale staged
			// conflict warning.
			assert.ok(readySnapshot, 'the ready event must have fired')
			assert.deepEqual(
				readySnapshot.filter(error => error.message.includes('impDocVisibilityConflict')),
				[],
			)
		} finally {
			await first?.close()
			await second?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc warm start changed file staged diagnostics rollback', () => {
	it('does not republish stale cached errors over a changed file fresh scan', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-changed-file-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-changed-file-cache-'),
		)
		let first: core.Project | undefined
		let second: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Changed file fixture"\n\t}\n}\n',
			)
			// No IMP-Doc content on purpose: the queued-lint drain must stay out
			// of this URI so the assertion isolates the staged publish ordering.
			const plain = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/plain.mcfunction',
				'badcommand foo\n',
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)
			const watchedUris = [pack.uri, plain.uri]

			first = createRuntimeProject(cacheDir, projectRootUri)
			await first.init()
			await first.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })
			assert.ok(
				(first.cacheService.errors[plain.uri] ?? []).length > 0,
				'the broken command must seed a cached diagnostic',
			)
			await first.close()
			first = undefined

			// Fix the file while no project is running.
			await writeFile(plain.path, '# fixed\n')

			second = createRuntimeProject(cacheDir, projectRootUri)
			await second.init()
			await second.ready({ projectRootsWatcher: new FixtureWatcher(watchedUris) })

			// The changed file publishes fresh (clean) diagnostics during the
			// scan; the stale staged entry must not roll them back.
			assert.deepEqual(second.cacheService.errors[plain.uri] ?? [], [])
		} finally {
			await first?.close()
			await second?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc header desc priority over declaration desc', () => {
	it('keeps the header hover desc regardless of bind order and declaration removal', async () => {
		const projectRoot = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-desc-priority-project-'),
		)
		const cacheDir = await createCanonicalTempDir(
			join(tmpdir(), 'spyglass-imp-doc-desc-priority-cache-'),
		)
		let project: core.Project | undefined
		try {
			const pack = await writeRuntimeFixtureFile(
				projectRoot,
				'pack.mcmeta',
				'{\n\t"pack": {\n\t\t"pack_format": 26,\n\t\t"description": "Desc priority fixture"\n\t}\n}\n',
			)
			const target = await writeRuntimeFixtureFile(
				projectRoot,
				'data/a/functions/target.mcfunction',
				'#> a:target\n# @public\n# Target header description\n',
			)
			const declContent = '#> b:decl\n# @public\n\n'
				+ '#> Declaration description text\n# @private\n#declare function a:target\n'
			const decl = await writeRuntimeFixtureFile(
				projectRoot,
				'data/b/functions/decl.mcfunction',
				declContent,
			)
			const projectRootUri = core.fileUtil.ensureEndingSlash(
				core.normalizeUri(pathToFileURL(projectRoot).toString()),
			)

			project = createRuntimeProject(cacheDir, projectRootUri)
			await project.init()
			// The watcher order fixes the scan order (default uriSorter is
			// stable), so the header binds before the cross-document #declare:
			// last-bind-wins would clobber the header desc here.
			await project.ready({
				projectRootsWatcher: new FixtureWatcher([pack.uri, target.uri, decl.uri]),
			})
			const symbol = project.symbols.lookup('function', ['a:target']).symbol
			assert.ok(symbol)
			assert.match(symbol.desc ?? '', /\*\*Visibility:\*\*/)
			assert.match(symbol.desc ?? '', /Target header description/)
			assert.doesNotMatch(symbol.desc ?? '', /Declaration description text/)

			// Removing the canonical declaration must not clobber the header desc
			// either (the desc restore only applies to headerless symbols).
			await project.onDidOpen(decl.uri, 'mcfunction', 1, declContent)
			await project.onDidChange(decl.uri, [{ text: '#> b:decl\n# @public\n' }], 2)
			const after = project.symbols.lookup('function', ['a:target']).symbol
			assert.ok(after)
			assert.match(after.desc ?? '', /\*\*Visibility:\*\*/)
			assert.match(after.desc ?? '', /Target header description/)
		} finally {
			await project?.close()
			await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})
})

describe('IMP-Doc conflict linter reverse URI cache re-verification', () => {
	it('skips stale candidates whose locations at the document were removed', () => {
		const staleUri = 'file:///fixture/stale.mcfunction'
		const ownerUri = 'file:///fixture/owner.mcfunction'
		const sideUri = 'file:///fixture/side.mcfunction'
		const symbols = new core.SymbolUtil({})
		symbols.contributeAs('binder', () => {
			for (const uri of [staleUri, ownerUri, sideUri]) {
				symbols.query(uri, 'storage', 'shared:data').enter({
					usage: { type: 'declaration' },
				})
			}
		})
		symbols.buildCache()
		const symbol = symbols.lookup('storage', ['shared:data']).symbol
		assert.ok(symbol)
		// A public + private union across the other documents keeps a live
		// conflict on the symbol.
		stampVisibility(symbol, { type: 'public' }, {
			uri: ownerUri,
			range: { start: 0, end: 1 },
			owner: 'a:owner',
		})
		stampVisibility(symbol, { type: 'private', owner: 'b:side' }, {
			uri: sideUri,
			range: { start: 0, end: 1 },
			owner: 'b:side',
		})
		// Remove the stale document's locations; per contract the reverse URI
		// cache intentionally keeps its entry as a stale superset.
		symbols.clear({ uri: staleUri })
		assert.ok(symbols.getSymbolCandidatesAtUri(staleUri).length > 0)

		const queued: string[] = []
		const ctx = {
			doc: { uri: staleUri },
			err: {
				lint: () => assert.fail('the stale document must not own conflict diagnostics'),
			},
			queueLint: (uri: string) => queued.push(uri),
			symbols,
		} as unknown as core.LinterContext
		visibilityConflict({} as core.StateProxy<core.AstNode>, ctx)
		assert.deepEqual(queued, [])
	})
})
