import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { initialize as initializeImpDoc } from '../lib/index.js'

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
	await initializeImpDoc(ctx)
	return { loadedVersion: '1.20.4', errorSource: '1.20.4' }
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

		project = new core.Project({
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
			projectRoots: [FixtureRoot],
		})

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

	it('warns on private-owner and public-restricted conflicts in the first declaring file', () => {
		const errors = getState('index').node.linterErrors ?? []
		assert.equal(errors.length, 2)
		for (const error of errors) {
			assert.equal(error.severity, core.ErrorSeverity.Warning)
			assert.match(error.message, /impDocVisibilityConflict/)
		}
		assert.match(
			errors[0]!.message,
			/private to “owner:_index\.d” here and private to “external:second_owner”/,
		)
		assert.match(errors[1]!.message, /public here but restricted/)
	})

	it('warns on the counterpart declaring file as well', () => {
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

	it('does not warn on same-owner private duplicates or on within unions', () => {
		// dup:data is declared @private twice by the same owner and aj:remove has
		// two different @within declarations; neither may produce a conflict.
		// The exact-2 assertions above already exclude them, and the headerless
		// aj target plus the caller-local declare must stay conflict-free too.
		assert.deepEqual(getState('ajRemove').node.linterErrors ?? [], [])
		assert.deepEqual(getState('caller').node.linterErrors ?? [], [])
	})
})
