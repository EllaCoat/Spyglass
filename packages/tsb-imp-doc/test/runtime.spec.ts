import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getImpDocSymbolData, ImpDocNode, initialize as initializeImpDoc } from '../lib/index.js'

const Target = 'owner:helper'
const MalformedTarget = 'owner:malformed'
// Canonicalize fixture URIs with core.normalizeUri (lowercases Windows drive letters,
// like UriStore does for watched files) so that projectRoots, watcher entries, and
// assertions all compare the same URI form. See core/common/util.ts#normalizeUriPathname.
const FixtureRoot = core.fileUtil.ensureEndingSlash(
	core.normalizeUri(new URL('./runtime/private-project/', import.meta.url).toString()),
)

const RuntimeFiles = {
	index: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/owner/functions/_index.d.mcfunction',
			import.meta.url,
		).toString(),
	),
	helper: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/owner/functions/helper.mcfunction',
			import.meta.url,
		).toString(),
	),
	malformedTarget: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/owner/functions/malformed.mcfunction',
			import.meta.url,
		).toString(),
	),
	main: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/owner/functions/main.mcfunction',
			import.meta.url,
		).toString(),
	),
	external: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/external/functions/caller.mcfunction',
			import.meta.url,
		).toString(),
	),
	denied: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/other/functions/denied.mcfunction',
			import.meta.url,
		).toString(),
	),
	malformedCaller: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/external/functions/malformed_caller.mcfunction',
			import.meta.url,
		).toString(),
	),
	noHeader: core.normalizeUri(
		new URL(
			'./runtime/private-project/data/no_header/functions/caller.mcfunction',
			import.meta.url,
		).toString(),
	),
} as const

const FunctionIds = {
	index: 'owner:_index.d',
	helper: 'owner:helper',
	malformedTarget: MalformedTarget,
	main: 'owner:main',
	external: 'external:caller',
	denied: 'other:denied',
	malformedCaller: 'external:malformed_caller',
	noHeader: 'no_header:caller',
} as const

type RuntimeFile = keyof typeof RuntimeFiles
type RuntimeState = core.DocAndNode & { content: string }

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
	return config
}

function getState(
	states: ReadonlyMap<RuntimeFile, RuntimeState>,
	file: RuntimeFile,
): RuntimeState {
	const state = states.get(file)
	assert.ok(state, `${file} should have been opened and checked`)
	return state
}

function findImpDoc(
	state: RuntimeState,
	predicate: (node: ImpDocNode) => boolean,
): ImpDocNode {
	let result: ImpDocNode | undefined
	core.traversePreOrder(
		state.node,
		() => result === undefined,
		ImpDocNode.is,
		(node) => {
			if (predicate(node)) {
				result = node
			}
		},
	)
	assert.ok(result, `Expected an IMP-Doc node in ${state.doc.uri}`)
	return result
}

function assertNoViolation(state: RuntimeState): void {
	assert.deepEqual(state.node.linterErrors ?? [], [])
}

function findFunctionCall(state: RuntimeState): core.ResourceLocationNode {
	let result: core.ResourceLocationNode | undefined
	core.traversePreOrder(
		state.node,
		() => result === undefined,
		core.ResourceLocationNode.is,
		(node) => {
			if (node.options.category === 'function') {
				result = node
			}
		},
	)
	assert.ok(result)
	return result
}

function completeFunctionCall(
	project: core.Project,
	state: RuntimeState,
): core.CompletionItem[] {
	const call = findFunctionCall(state)
	const ctx = core.CompleterContext.create(project, {
		doc: state.doc,
		offset: call.range.end,
	})
	return core.completer.file(state.node, ctx)
}

function completionKey(item: core.CompletionItem): string {
	return `${item.label}\0${item.range.start}:${item.range.end}`
}

function assertSingleViolation(
	state: RuntimeState,
	caller: string,
	target = Target,
): void {
	const errors = state.node.linterErrors ?? []
	assert.equal(errors.length, 1)

	const targetStart = state.content.lastIndexOf(target)
	assert.notEqual(targetStart, -1)
	assert.deepEqual(
		errors[0].range,
		core.Range.create(targetStart, targetStart + target.length),
	)
	assert.match(errors[0].message, /impDocPrivate/)
	assert.match(errors[0].message, new RegExp(target))
	assert.match(errors[0].message, new RegExp(caller))
}

describe('IMP-Doc private visibility runtime', () => {
	const states = new Map<RuntimeFile, RuntimeState>()
	let project: core.Project | undefined
	let cacheDir: string | undefined

	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-'))
		const packMcmeta = core.normalizeUri(
			new URL('./runtime/private-project/pack.mcmeta', import.meta.url).toString(),
		)
		const watcher = new FixtureWatcher([
			packMcmeta,
			...Object.values(RuntimeFiles),
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

		// Check the target before callers so its Restricted metadata is present
		// while each caller is bound.
		for (
			const file of [
				'index',
				'helper',
				'malformedTarget',
				'main',
				'external',
				'denied',
				'malformedCaller',
			] as const
		) {
			const uri = RuntimeFiles[file]
			const content = await readFile(fileURLToPath(uri), 'utf8')
			await project.onDidOpen(uri, 'mcfunction', 1, content)
			const result = project.getClientManaged(uri)
			assert.ok(result)
			states.set(file, { ...result, content })
		}
	})

	after(async () => {
		await project?.close()
		if (cacheDir) {
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('registers real-layout function definitions through the URI binder', () => {
		assert.ok(project)
		for (const file of Object.keys(FunctionIds) as RuntimeFile[]) {
			const symbol = project.symbols.lookup(
				'function',
				[FunctionIds[file]],
			).symbol
			assert.ok(symbol, `${FunctionIds[file]} should be registered`)
			assert.ok(
				symbol.definition?.some(
					location => location.uri === RuntimeFiles[file],
				),
				`${FunctionIds[file]} should have a URI-binder definition`,
			)
		}

		const index = getState(states, 'index')
		const declaration = findImpDoc(index, node => node.declaration !== undefined)
		assert.deepEqual(
			declaration.declaration?.lines.map(line => line.raw),
			['#declare storage owner:runtime'],
		)
	})

	it('stamps metadata on the raw symbol but filters normal query()', () => {
		assert.ok(project)
		const helper = getState(states, 'helper')
		const doc = findImpDoc(
			helper,
			node => node.functionID?.raw === Target,
		)
		assert.deepEqual(
			ImpDocNode.flattenAnnotations(doc.annotations)
				.map(values => values.map(value => value.raw)),
			[
				['@private'],
				['@within', 'function', 'owner:main'],
			],
		)

		const rawSymbol = project.symbols.lookup(
			'function',
			[Target],
		).symbol
		assert.ok(rawSymbol)
		const helperData = getImpDocSymbolData(rawSymbol.data)
		assert.equal(helperData?.privateOwner, Target)
		assert.deepEqual(helperData?.visibility, {
			type: 'within',
			owner: Target,
			includeOwner: true,
			patterns: [{
				raw: 'owner:main',
				targetType: 'function',
				regex: '^owner:main$',
			}],
		})
		assert.equal(
			project.symbols.query(helper.doc, 'function', Target).symbol,
			undefined,
		)
	})

	it('stamps malformed visibility as denied even when @public is present', () => {
		assert.ok(project)
		const symbol = project.symbols.lookup(
			'function',
			[MalformedTarget],
		).symbol
		assert.ok(symbol)
		assert.deepEqual(getImpDocSymbolData(symbol.data)?.visibility, {
			type: 'denied',
			owner: MalformedTarget,
		})
		assert.equal(symbol.visibility, 3)
		assert.match(symbol.desc ?? '', /Visibility:\*\* denied/)
	})

	it('registers #declare storage symbols through the impDoc:declaration binder', () => {
		assert.ok(project)
		const storageSymbol = project.symbols
			.lookup('storage', ['owner:runtime'])
			.symbol
		assert.ok(storageSymbol)
		const data = getImpDocSymbolData(storageSymbol.data)
		// _index.d の declaration doc は @public。 v3 union parity で visibility は
		// declaration entry 側に載り、 definition-side (`data.visibility`) は空。
		assert.equal(data?.visibility, undefined)
		assert.equal(data?.declarations?.length, 1)
		assert.deepEqual(data?.declarations?.[0]?.visibility, { type: 'public' })
		assert.equal(data?.declarations?.[0]?.owner, 'owner:_index.d')
		assert.equal(data?.declarations?.[0]?.uri, RuntimeFiles.index)
		// SymbolVisibility.Public = 2 (const enum、 数値照合)。
		assert.equal(storageSymbol.visibility, 2)
	})

	it('re-stamps a declaration visibility edited in the same URI', async () => {
		assert.ok(project)
		const original = getState(states, 'index').content
		const restricted = original.replace('# @public', '# @private')
		assert.notEqual(restricted, original)

		await project.onDidChange(RuntimeFiles.index, [{ text: restricted }], 2)
		let storageSymbol = project.symbols
			.lookup('storage', ['owner:runtime'])
			.symbol
		assert.ok(storageSymbol)
		let data = getImpDocSymbolData(storageSymbol.data)
		assert.equal(data?.declarations?.length, 1)
		assert.deepEqual(
			data?.declarations?.[0]?.visibility,
			{ type: 'private', owner: FunctionIds.index },
		)
		assert.equal(storageSymbol.visibility, 3)

		await project.onDidChange(RuntimeFiles.index, [{ text: original }], 3)
		storageSymbol = project.symbols
			.lookup('storage', ['owner:runtime'])
			.symbol
		assert.ok(storageSymbol)
		data = getImpDocSymbolData(storageSymbol.data)
		assert.equal(data?.declarations?.length, 1)
		assert.deepEqual(
			data?.declarations?.[0]?.visibility,
			{ type: 'public' },
		)
		assert.equal(storageSymbol.visibility, 2)
	})

	it('resolves a #declare owner registered as a CLI-style declaration', async () => {
		assert.ok(project)
		const uri = core.normalizeUri(
			new URL(
				'./runtime/private-project/data/cli/functions/owner.mcfunction',
				import.meta.url,
			).toString(),
		)
		const owner = 'cli:owner'
		const content = '#> cli:owner\n# @public\n\n'
			+ '#> CLI storage\n# @private\n#declare storage cli:data\n'

		project.symbols.contributeAs('uri_binder', () => {
			project!.symbols.query(uri, 'function', owner).enter({
				usage: { type: 'declaration' },
			})
		})
		await project.onDidOpen(uri, 'mcfunction', 1, content)

		const state = project.getClientManaged(uri)
		assert.ok(state)
		assert.deepEqual(state.node.binderErrors ?? [], [])
		const storageSymbol = project.symbols.lookup('storage', ['cli:data']).symbol
		assert.ok(storageSymbol)
		assert.equal(
			getImpDocSymbolData(storageSymbol.data)?.declarations?.[0]?.owner,
			owner,
		)
		await project.onDidClose(uri)
	})

	it('keeps the header @private when a following declaration doc is public', () => {
		// P1b の checker refactor で、 function symbol を触るのは functionID
		// を持つ header doc だけになった。 declaration doc (functionID 無し) の
		// @public は function symbol の visibility を上書きしないため、
		// owner:_index.d は最終的に Restricted のままとなる。
		assert.ok(project)
		const indexSymbol = project.symbols
			.lookup('function', ['owner:_index.d'])
			.symbol
		assert.ok(indexSymbol)
		// SymbolVisibility.Restricted = 3 (const enum、 strip-types loader では
		// inline されないため runtime に enum object が存在しない、 数値で照合)。
		assert.equal(indexSymbol.visibility, 3)
		assert.equal(
			getImpDocSymbolData(indexSymbol.data)?.privateOwner,
			'owner:_index.d',
		)
		assert.deepEqual(
			getImpDocSymbolData(indexSymbol.data)?.visibility,
			{ type: 'private', owner: 'owner:_index.d' },
		)
	})

	it('allows the private function to call itself', () => {
		assertNoViolation(getState(states, 'helper'))
	})

	it('allows a caller selected by @within', () => {
		assertNoViolation(getState(states, 'main'))
	})

	it('filters function completion by caller and dedupes built-in items', () => {
		assert.ok(project)

		const allowed = completeFunctionCall(project, getState(states, 'main'))
		assert.equal(
			allowed.filter(item => item.label === Target).length,
			1,
			'@within caller should receive owner:helper exactly once',
		)
		assert.equal(
			allowed.filter(item => item.label === FunctionIds.main).length,
			1,
			'public built-in candidate should be deduped',
		)
		assert.equal(
			new Set(allowed.map(completionKey)).size,
			allowed.length,
		)

		const denied = completeFunctionCall(
			project,
			getState(states, 'external'),
		)
		assert.equal(
			denied.filter(item => item.label === Target).length,
			0,
			'external caller must not receive owner:helper',
		)

		const malformedDenied = completeFunctionCall(
			project,
			getState(states, 'malformedCaller'),
		)
		assert.equal(
			malformedDenied.filter(item => item.label === MalformedTarget).length,
			0,
			'external caller must not receive a malformed visibility target',
		)
	})

	it('reports exactly one external private call', () => {
		assertSingleViolation(
			getState(states, 'external'),
			'external:caller',
		)
	})

	it('reports exactly one caller outside @within', () => {
		assertSingleViolation(
			getState(states, 'denied'),
			'other:denied',
		)
	})

	it('reports exactly one external call to a denied malformed target', () => {
		assertSingleViolation(
			getState(states, 'malformedCaller'),
			FunctionIds.malformedCaller,
			MalformedTarget,
		)
	})

	it('lints a private call from a function without an IMP-Doc header', async () => {
		assert.ok(project)
		const uri = RuntimeFiles.noHeader
		const content = await readFile(fileURLToPath(uri), 'utf8')
		await project.onDidOpen(uri, 'mcfunction', 1, content)
		const result = project.getClientManaged(uri)
		assert.ok(result)
		assertSingleViolation(
			{ ...result, content },
			FunctionIds.noHeader,
		)
	})

	it('clears stale function metadata when the header is deleted or mismatched', async () => {
		assert.ok(project)
		const original = getState(states, 'helper').content
		const symbol = project.symbols.lookup('function', [Target]).symbol
		assert.ok(symbol)

		await project.onDidChange(
			RuntimeFiles.helper,
			[{ text: 'function owner:helper\n' }],
			2,
		)
		assert.equal(getImpDocSymbolData(symbol.data), undefined)
		assert.equal(symbol.visibility, 2)
		assert.equal(symbol.visibilityRestriction, undefined)

		const mismatch = '#> owner:not-helper\n# @private\n\nfunction owner:helper\n'
		await project.onDidChange(RuntimeFiles.helper, [{ text: mismatch }], 3)
		assert.equal(getImpDocSymbolData(symbol.data), undefined)
		assert.equal(symbol.visibility, 2)
		assert.equal(symbol.visibilityRestriction, undefined)

		await project.onDidChange(RuntimeFiles.helper, [{ text: original }], 4)
		assert.deepEqual(
			getImpDocSymbolData(symbol.data)?.visibility,
			{
				type: 'within',
				owner: Target,
				includeOwner: true,
				patterns: [{
					raw: 'owner:main',
					targetType: 'function',
					regex: '^owner:main$',
				}],
			},
		)
		assert.equal(symbol.visibility, 3)
	})
})

describe('IMP-Doc private visibility runtime — open-order independence (P1b binder phase)', () => {
	let project: core.Project | undefined
	let cacheDir: string | undefined
	let externalState: RuntimeState | undefined

	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-order-'))
		const packMcmeta = core.normalizeUri(
			new URL('./runtime/private-project/pack.mcmeta', import.meta.url).toString(),
		)
		const watcher = new FixtureWatcher([
			packMcmeta,
			...Object.values(RuntimeFiles),
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

		// Open the caller BEFORE the private helper. In P1b, visibility stamp
		// moved from checker to binder phase, and Project.ready() binds every
		// file before any file is checked, so target metadata is available
		// regardless of open-order and the external violation must be reported.
		for (const file of ['index', 'external', 'helper'] as const) {
			const uri = RuntimeFiles[file]
			const content = await readFile(fileURLToPath(uri), 'utf8')
			await project.onDidOpen(uri, 'mcfunction', 1, content)
			if (file === 'external') {
				const result = project.getClientManaged(uri)
				assert.ok(result)
				externalState = { ...result, content }
			}
		}
	})

	after(async () => {
		await project?.close()
		if (cacheDir) {
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('reports the external caller even when helper is opened after it', () => {
		assert.ok(externalState)
		assertSingleViolation(externalState, 'external:caller')
	})
})

describe('IMP-Doc private visibility runtime — getCaller characterization', () => {
	let project: core.Project | undefined
	let cacheDir: string | undefined

	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-getcaller-'))
		const packMcmeta = core.normalizeUri(
			new URL('./runtime/private-project/pack.mcmeta', import.meta.url).toString(),
		)
		const watcher = new FixtureWatcher([
			packMcmeta,
			...Object.values(RuntimeFiles),
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
	})

	after(async () => {
		await project?.close()
		if (cacheDir) {
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	function fixtureUri(path: string): string {
		return core.normalizeUri(
			new URL(`./runtime/private-project/${path}`, import.meta.url).toString(),
		)
	}

	function enterFunction(
		usage: core.SymbolUsageType,
		id: string,
		uri: string,
	): void {
		project!.symbols.contributeAs('uri_binder', () => {
			project!.symbols.query(uri, 'function', id).enter({ usage: { type: usage } })
		})
	}

	async function lintSyntheticCaller(uri: string): Promise<RuntimeState> {
		assert.ok(project)
		const content = 'function owner:helper\n'
		await project.onDidOpen(uri, 'mcfunction', 1, content)
		const state = project.getClientManaged(uri)
		assert.ok(state)
		await project.onDidClose(uri)
		return { ...state, content }
	}

	it('resolves the declaration fallback in symbol-map insertion order, not location-entry order', async () => {
		const callerUri = fixtureUri('data/order/functions/decl_caller.mcfunction')
		const elsewhereUri = fixtureUri('data/order/functions/elsewhere.mcfunction')
		// `order:second` enters the function symbol map first (via a location at a
		// different URI), while its declaration at `callerUri` is entered only after
		// `order:first`. The legacy getCaller scans the symbol map in insertion
		// order, so the caller must resolve to `order:second` even though
		// `order:first` contributed a location to `callerUri` earlier.
		enterFunction('declaration', 'order:second', elsewhereUri)
		enterFunction('declaration', 'order:first', callerUri)
		enterFunction('declaration', 'order:second', callerUri)

		const state = await lintSyntheticCaller(callerUri)
		assertSingleViolation(state, 'order:second')
	})

	it('prefers a definition over an earlier-inserted declaration', async () => {
		const callerUri = fixtureUri('data/order/functions/def_caller.mcfunction')
		// `order:decl` is inserted into the symbol map before `order:def`, but a
		// definition always wins over a declaration regardless of insertion order.
		enterFunction('declaration', 'order:decl', callerUri)
		enterFunction('definition', 'order:def', callerUri)

		const state = await lintSyntheticCaller(callerUri)
		assertSingleViolation(state, 'order:def')
	})
})
