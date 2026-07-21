import * as core from '@spyglassmc/core'
import { NodeJsExternals } from '@spyglassmc/core/lib/nodejs.js'
import * as je from '@spyglassmc/java-edition'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
	getRefProvenance,
	initialize as initializeImpDoc,
	scanLineFunctionRefs,
} from '../lib/index.js'

// Canonicalize fixture URIs with core.normalizeUri (lowercases Windows drive letters,
// like UriStore does for watched files) so that projectRoots, watcher entries, and
// assertions all compare the same URI form.
const FixtureRoot = core.fileUtil.ensureEndingSlash(
	core.normalizeUri(new URL('./runtime/macro-project/', import.meta.url).toString()),
)

const CallerUri = core.normalizeUri(
	new URL(
		'./runtime/macro-project/data/example/functions/caller.m.mcfunction',
		import.meta.url,
	).toString(),
)
const PrivateUri = core.normalizeUri(
	new URL(
		'./runtime/macro-project/data/example/functions/private.mcfunction',
		import.meta.url,
	).toString(),
)
const PackMcmetaUri = core.normalizeUri(
	new URL('./runtime/macro-project/pack.mcmeta', import.meta.url).toString(),
)

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
	lint['impDocPrivateBestEffort'] = 'warning'
	return config
}

function collectMacroNodes(root: core.AstNode): core.AstNode[] {
	const macros: core.AstNode[] = []
	core.traversePreOrder(
		root,
		() => true,
		(node): node is core.AstNode => node.type === 'mcfunction:macro',
		(node) => macros.push(node),
	)
	return macros
}

function nestedRefs(macro: core.AstNode): core.ResourceLocationNode[] {
	const refs: core.ResourceLocationNode[] = []
	for (const segment of macro.children ?? []) {
		if (segment.type !== 'mcfunction:macro/other') {
			continue
		}
		for (const child of segment.children ?? []) {
			if (core.ResourceLocationNode.is(child)) {
				refs.push(child)
			}
		}
	}
	return refs
}

describe('IMP-Doc function reference scanner', () => {
	it('captures slash-delimited paths in default-namespace functions and tags', () => {
		for (const raw of ['foo/bar', '#foo/bar']) {
			const line = `execute run function ${raw}`
			const lineStart = 37
			const result = scanLineFunctionRefs(line, lineStart, false)
			const targetStart = lineStart + line.indexOf(raw)

			assert.deepEqual(result.dynamicRanges, [])
			assert.equal(result.refs.length, 1)
			assert.deepEqual(result.refs[0], {
				type: 'resource_location',
				range: core.Range.create(targetStart, targetStart + raw.length),
				namespace: undefined,
				path: ['foo', 'bar'],
				isTag: raw.startsWith('#'),
				options: {
					category: 'function',
					allowTag: true,
					usageType: 'reference',
				},
			})
		}
	})
})

describe('IMP-Doc macro decoration on the language-server path', () => {
	let project: core.Project | undefined
	let cacheDir: string | undefined
	let state: core.DocAndNode | undefined

	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), 'spyglass-imp-doc-macro-'))
		project = new core.Project({
			cacheRoot: core.fileUtil.ensureEndingSlash(
				pathToFileURL(cacheDir).toString(),
			),
			defaultConfig: createConfig(),
			externals: NodeJsExternals,
			initializers: [async (ctx) => {
				ctx.meta.registerUriBinder(je.binder.uriBinder)
				je.mcf.initialize(ctx, Commands, '1.20.4')
				const inner = (await initializeImpDoc(ctx)) ?? {}
				return { ...inner, loadedVersion: '1.20.4', errorSource: '1.20.4' }
			}],
			logger: {
				error: () => {},
				info: () => {},
				log: () => {},
				warn: () => {},
			},
			projectRoots: [FixtureRoot],
		})
		await project.init()
		const watcher = new FixtureWatcher([PackMcmetaUri, CallerUri, PrivateUri])
		await project.ready({ projectRootsWatcher: watcher })

		const content = new TextDecoder().decode(
			await project.externals.fs.readFile(CallerUri),
		)
		await project.onDidOpen(CallerUri, 'mcfunction', 1, content)
		state = project.getClientManaged(CallerUri)
	})

	after(async () => {
		await project?.close()
		if (cacheDir) {
			await rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
		}
	})

	it('nests scanned static refs as children of their macro/other segment', () => {
		assert.ok(state)
		const macros = collectMacroNodes(state.node)
		assert.equal(macros.length, 4)

		const [privateRef] = nestedRefs(macros[0]!)
		assert.ok(privateRef)
		assert.equal(core.ResourceLocationNode.toString(privateRef, 'full'), 'example:private')
		assert.equal(getRefProvenance(privateRef), 'macro')

		const [missingRef] = nestedRefs(macros[1]!)
		assert.ok(missingRef)
		assert.equal(
			core.ResourceLocationNode.toString(missingRef, 'full'),
			'example:missing_static',
		)
		assert.equal(getRefProvenance(missingRef), 'macro')

		// Fully dynamic and `$(...)`-completed targets receive no ref node.
		assert.deepEqual(nestedRefs(macros[2]!), [])
		assert.deepEqual(nestedRefs(macros[3]!), [])
	})

	it('binds nested refs so the existence check cannot misfire', () => {
		assert.ok(state)
		const macros = collectMacroNodes(state.node)
		const [privateRef] = nestedRefs(macros[0]!)
		assert.ok(privateRef?.symbol)
		assert.equal(
			(privateRef.symbol.declaration?.length ?? 0)
					+ (privateRef.symbol.definition?.length ?? 0) > 0,
			true,
		)
	})

	it('routes macro refs to impDocPrivateBestEffort warnings only', () => {
		assert.ok(state)
		const errors = state.node.linterErrors ?? []
		assert.deepEqual(
			errors.map(error => [error.severity, error.message]),
			[
				[
					core.ErrorSeverity.Warning,
					'Function “example:private” is private to “example:private” and cannot be called from “example:caller.m” (referenced in a macro line) (rule: impDocPrivateBestEffort)',
				],
				[
					core.ErrorSeverity.Warning,
					'Function “example:missing_static” is referenced in a macro line but is not declared anywhere (rule: impDocPrivateBestEffort)',
				],
			],
		)
	})
})
