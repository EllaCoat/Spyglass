import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
	getImpDocSymbolData,
	initialize as initializeImpDoc,
	matchesAnyVisibility,
} from '../lib/index.js'

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

	constructor(uris: readonly string[]) {
		super()
		for (const uri of uris) {
			this.watchedFiles.add(uri)
		}
	}

	async ready(): Promise<void> {}

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
): core.Project {
	return new core.Project({
		cacheRoot: core.fileUtil.ensureEndingSlash(
			pathToFileURL(cacheDir).toString(),
		),
		defaultConfig: createConfig(),
		externals: NodeJsExternals,
		initializers: [initializeRuntime],
		logger: {
			error: () => {},
			info: () => {},
			log: () => {},
			warn: () => {},
		},
		projectRoots: [projectRoot],
	})
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
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-union-'))
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
		const projectRoot = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-conflict-project-'))
		const cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-conflict-cache-'))
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
		const projectRoot = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-union-project-'))
		const cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-union-cache-'))
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
