import * as core from '@spyglassmc/core'
import { mockProjectData } from '@spyglassmc/core/test/utils.ts'
import { command as commandChecker } from '@spyglassmc/java-edition/lib/mcfunction/checker/index.js'
import { argument } from '@spyglassmc/java-edition/lib/mcfunction/parser/index.js'
import { getPatch } from '@spyglassmc/java-edition/lib/mcfunction/tree/patch.js'
import type { McdocType } from '@spyglassmc/mcdoc'
import type { TypeDefSymbolData } from '@spyglassmc/mcdoc/lib/binder/index.js'
import * as mcf from '@spyglassmc/mcfunction'
import * as nbt from '@spyglassmc/nbt'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TextDocument } from 'vscode-languageserver-textdocument'

/**
 * A cut-down `data modify entity <target> <targetPath> ...` subtree, shaped like the vanilla
 * command tree so that the real {@link getPatch} can be merged on top of it. The patch is what
 * wires `dispatcher` / `indexedBy` / `isMerge` / `isListIndex` onto the NBT arguments, i.e. the
 * behavior under test.
 */
const VanillaShapedTree: mcf.RootTreeNode = {
	type: 'root',
	children: {
		data: {
			type: 'literal',
			children: {
				modify: {
					type: 'literal',
					children: {
						entity: {
							type: 'literal',
							children: {
								target: {
									type: 'argument',
									parser: 'minecraft:entity',
									properties: { amount: 'single', type: 'entities' },
									children: {
										targetPath: {
											type: 'argument',
											parser: 'minecraft:nbt_path',
											children: {
												append: { type: 'literal', children: getSourceChildren() },
												insert: {
													type: 'literal',
													children: {
														index: {
															type: 'argument',
															parser: 'brigadier:integer',
															children: getSourceChildren(),
														},
													},
												},
												merge: { type: 'literal', children: getSourceChildren() },
												prepend: { type: 'literal', children: getSourceChildren() },
												set: { type: 'literal', children: getSourceChildren() },
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
}

function getSourceChildren(): mcf.TreeNode['children'] {
	return {
		value: {
			type: 'literal',
			children: {
				value: { type: 'argument', parser: 'minecraft:nbt_tag', executable: true },
			},
		},
	}
}

const Tree = core.merge(VanillaShapedTree, getPatch('1.20.4'))

const CanonicalAttribute = [{ name: 'canonical' }]

/**
 * Mirrors `java/world/entity/display.mcdoc` of vanilla-mcdoc for 1.20.4:
 * both members of `Transformation` and of `Rotation` are accepted by the game, but only one of
 * each is `#[canonical]`.
 */
function initSymbols(symbols: core.SymbolUtil) {
	const doc = TextDocument.create('', '', 0, '')
	const defineType = (path: string, typeDef: McdocType) =>
		symbols.query(doc, 'mcdoc', path).enter({
			data: { subcategory: 'type_alias', data: { typeDef } },
			usage: { type: 'definition' },
		})
	const floatList = (length: number): McdocType => ({
		kind: 'list',
		item: { kind: 'float' },
		lengthRange: { kind: 0b00, min: length, max: length },
	})

	defineType('::test::Transformation', {
		kind: 'union',
		members: [
			{
				kind: 'struct',
				attributes: CanonicalAttribute,
				fields: [
					{ kind: 'pair', key: 'translation', type: floatList(3) },
					{
						kind: 'pair',
						key: 'left_rotation',
						type: { kind: 'reference', path: '::test::Rotation' },
					},
					{
						kind: 'pair',
						key: 'right_rotation',
						type: { kind: 'reference', path: '::test::Rotation' },
					},
					{ kind: 'pair', key: 'scale', type: floatList(3) },
				],
			},
			floatList(16),
		],
	})
	defineType('::test::Rotation', {
		kind: 'union',
		members: [
			{ ...floatList(4), attributes: CanonicalAttribute },
			{ kind: 'reference', path: '::test::AxisAngle' },
		],
	})
	defineType('::test::AxisAngle', {
		kind: 'struct',
		fields: [
			{ kind: 'pair', key: 'angle', type: { kind: 'float' } },
			{ kind: 'pair', key: 'axis', type: floatList(3) },
		],
	})

	symbols.query(doc, 'mcdoc/dispatcher', 'minecraft:entity').enter({
		usage: { type: 'reference' },
	})
	symbols.query(doc, 'mcdoc/dispatcher', 'minecraft:entity', 'block_display').enter({
		data: {
			data: {
				typeDef: {
					kind: 'struct',
					fields: [
						{
							kind: 'pair',
							key: 'transformation',
							type: { kind: 'reference', path: '::test::Transformation' },
						},
						{
							kind: 'pair',
							key: 'Tags',
							type: { kind: 'list', item: { kind: 'string' } },
						},
						{
							kind: 'pair',
							key: 'billboard',
							type: { kind: 'literal', value: { kind: 'string', value: 'fixed' } },
						},
					],
				} satisfies McdocType,
			},
		},
		usage: { type: 'definition' },
	})
}

interface CheckResult {
	errors: readonly core.LanguageError[]
	pathNode: nbt.NbtPathNode
}

/**
 * @param symbols A symbol table to adopt as-is, standing in for the one a session restores from
 * the on-disk cache. When omitted, a fresh one is populated by {@link initSymbols}.
 */
function createProject(enableMcdocCaching = false, symbols?: core.SymbolTable) {
	const project = mockProjectData({
		ctx: { loadedVersion: '1.20.4' },
		config: {
			...core.VanillaConfig,
			env: { ...core.VanillaConfig.env, enableMcdocCaching },
		},
		symbols: symbols ? new core.SymbolUtil(symbols) : undefined,
	})
	nbt.initialize({ ...project, reinitializeOnChange: () => {} })
	if (!symbols) {
		initSymbols(project.symbols)
	}
	return project
}

/** The round trip a symbol table makes through the on-disk cache. */
function reloadSymbols(symbols: core.SymbolUtil): core.SymbolTable {
	return core.SymbolTable.deserialize(core.SymbolTable.serialize(symbols.global))
}

function getTypeDefSymbols(symbols: core.SymbolUtil): TypeDefSymbolData[] {
	return Object.values(symbols.global.mcdoc ?? {})
		.map(symbol => symbol.data as TypeDefSymbolData | undefined)
		.filter((data): data is TypeDefSymbolData => data?.typeDef !== undefined)
}

function check(project: core.ProjectData, content: string): CheckResult {
	const doc = TextDocument.create('file:///test.mcfunction', 'mcfunction', 0, content)
	const src = new core.Source(content)
	const parserCtx = core.ParserContext.create(project, { doc })
	const node = mcf.command(Tree, argument)(src, parserCtx)
	assert.deepEqual(
		parserCtx.err.dump().map(e => e.message),
		[],
		`Unexpected parser errors for ${JSON.stringify(content)}`,
	)
	core.AstNode.setParents(node)

	const checkerCtx = core.CheckerContext.create(project, { doc })
	commandChecker(node, checkerCtx)

	const pathNode = findNode(node, 'nbt:path') as nbt.NbtPathNode
	return { errors: checkerCtx.err.dump(), pathNode }
}

function findNode(root: core.AstNode, type: string): core.AstNode {
	if (root.type === type) {
		return root
	}
	for (const child of root.children ?? []) {
		const found = findNodeOrUndefined(child, type)
		if (found) {
			return found
		}
	}
	assert.fail(`Could not find a ${type} node`)
}

function findNodeOrUndefined(root: core.AstNode, type: string): core.AstNode | undefined {
	if (root.type === type) {
		return root
	}
	for (const child of root.children ?? []) {
		const found = findNodeOrUndefined(child, type)
		if (found) {
			return found
		}
	}
	return undefined
}

function assertNoErrors(result: CheckResult, content: string) {
	assert.deepEqual(
		result.errors.map(e => `${e.message} @ ${e.range.start}..${e.range.end}`),
		[],
		`Expected no errors for ${JSON.stringify(content)}`,
	)
}

const DecomposedValue =
	'{translation:[0.0f,0.0f,0.0f],left_rotation:[0.0f,0.0f,0.0f,1.0f],right_rotation:[0.0f,0.0f,0.0f,1.0f],scale:[1.0f,1.0f,1.0f]}'
const MatrixValue = `[${Array<string>(16).fill('0.0f').join(',')}]`

describe('mcfunction checker data modify ... value', () => {
	const acceptedCases: string[] = [
		// Both members of `Transformation` are valid write targets.
		`data modify entity @s transformation set value ${MatrixValue}`,
		`data modify entity @s transformation set value ${DecomposedValue}`,
		// Both members of `Rotation` are valid write targets.
		'data modify entity @s transformation.left_rotation set value [0.0f,0.0f,0.0f,1.0f]',
		'data modify entity @s transformation.left_rotation set value {angle:0.1745f,axis:[0.0f,1.0f,0.0f]}',
		// `merge` and the list modifications stay wired up.
		'data modify entity @s transformation merge value {}',
		'data modify entity @s Tags append value "foo"',
		'data modify entity @s Tags prepend value "foo"',
		'data modify entity @s Tags insert 0 value "foo"',
		'data modify entity @s transformation append value 1.0f',
		// A trailing filter does not advance the path, so the end of it is still `transformation`.
		`data modify entity @s transformation{} set value ${DecomposedValue}`,
		// A literal end of a path accepts that literal.
		'data modify entity @s billboard set value "fixed"',
	]
	for (const content of acceptedCases) {
		it(`Should accept '${content}'`, () => {
			assertNoErrors(check(createProject(), content), content)
		})
	}

	const rejectedCases: { content: string; errors: string[] }[] = [
		// Not any of the union members, both of which are reported as expected.
		{
			content: 'data modify entity @s transformation set value "hello"',
			errors: ['Expected a map-like or a list'],
		},
		// Right shape, wrong length.
		{
			content: 'data modify entity @s transformation set value [1.0f,2.0f]',
			errors: ['Expected collection length to be at least 16 and at most 16'],
		},
		// Right shape, wrong element type inside the non-canonical member.
		{
			content:
				'data modify entity @s transformation.left_rotation set value {angle:0.1745f,axis:"nope"}',
			errors: ['Expected a list'],
		},
		// Unknown key of the non-canonical member.
		{
			content:
				'data modify entity @s transformation.left_rotation set value {angle:0.1745f,axis:[0.0f,1.0f,0.0f],nope:1b}',
			errors: ['Unknown key “nope”'],
		},
		// List item type is still enforced through `getListLikeChild`.
		{
			content: 'data modify entity @s Tags append value 1b',
			errors: ['Expected a string'],
		},
		// A trailing filter must not drop the end type and leave the value unchecked.
		{
			content: 'data modify entity @s transformation{} set value "hello"',
			errors: ['Expected a map-like or a list'],
		},
		// Neither must a literal end type.
		{
			content: 'data modify entity @s billboard set value "other"',
			errors: ['Expected “fixed”'],
		},
	]
	for (const { content, errors: expected } of rejectedCases) {
		it(`Should reject '${content}'`, () => {
			const { errors } = check(createProject(), content)
			assert.deepEqual(errors.map(e => e.message), expected)
		})
	}

	it('Should keep the canonical type on the path node itself', () => {
		const content = `data modify entity @s transformation set value ${MatrixValue}`
		const { pathNode } = check(createProject(), content)
		// The path is walked in a read context, where `#[canonical]` picks a single member.
		assert.equal(pathNode.endTypeDef?.kind, 'struct')
	})

	describe('with mcdoc caching enabled', () => {
		// The simplified type cache is shared between the canonical (path walking) and the
		// non-canonical (written value) resolutions, so a stale entry would make the outcome
		// depend on which command is checked first.
		const canonicalFirst = [
			'data modify entity @s transformation.left_rotation set value [0.0f,0.0f,0.0f,1.0f]',
			`data modify entity @s transformation set value ${MatrixValue}`,
		]
		const nonCanonicalFirst = [...canonicalFirst].reverse()

		for (
			const [name, contents] of [
				['canonical resolution first', canonicalFirst],
				['non-canonical resolution first', nonCanonicalFirst],
			] as const
		) {
			it(`Should not leak a cached type across contexts (${name})`, () => {
				const project = createProject(true)
				for (const content of contents) {
					assertNoErrors(check(project, content), content)
				}
			})
		}

		it('Should keep the canonical type on the path node after a write resolution', () => {
			const project = createProject(true)
			const first = `data modify entity @s transformation set value ${MatrixValue}`
			assertNoErrors(check(project, first), first)
			const second =
				'data modify entity @s transformation.left_rotation set value [0.0f,0.0f,0.0f,1.0f]'
			const result = check(project, second)
			assertNoErrors(result, second)
			assert.equal(result.pathNode.endTypeDef?.kind, 'list')
		})

		// Symbols, and with them the cached simplified types, are restored from disk as they were
		// written, so the resolutions of a warm start have to hold up on their own.
		const warmStartCases = [
			`data modify entity @s transformation set value ${MatrixValue}`,
			'data modify entity @s transformation.left_rotation set value {angle:0.1745f,axis:[0.0f,1.0f,0.0f]}',
		]

		it('Should survive a cache reload', () => {
			const first = createProject(true)
			for (const content of warmStartCases) {
				assertNoErrors(check(first, content), content)
			}
			assert.ok(
				getTypeDefSymbols(first.symbols).some(data => data.simplifiedTypeDefs),
				'Nothing was cached, so the reload would not prove anything',
			)

			const second = createProject(true, reloadSymbols(first.symbols))
			for (const content of warmStartCases) {
				assertNoErrors(check(second, content), content)
			}
		})

		it('Should ignore a simplified type cached before the canonical split', () => {
			const first = createProject(true)
			// Walking a path is the canonical context, so this fills the cache with the types a
			// pre-split build would have put in its single slot.
			const priming =
				'data modify entity @s transformation.left_rotation set value [0.0f,0.0f,0.0f,1.0f]'
			assertNoErrors(check(first, priming), priming)

			let downgraded = 0
			for (const data of getTypeDefSymbols(first.symbols)) {
				if (!data.simplifiedTypeDefs?.canonical) {
					continue
				}
				delete data.simplifiedTypeDefs
				// Deliberately not the canonical type this stood for. A slot that cannot be
				// attributed to either context must not reach a resolution at all, so what it
				// holds may not matter, and a wrong type makes any use of it observable.
				data.simplifiedTypeDef = { kind: 'string' }
				downgraded += 1
			}
			assert.notEqual(downgraded, 0, 'No cached type to downgrade, so nothing is covered')

			const second = createProject(true, reloadSymbols(first.symbols))
			for (const content of warmStartCases) {
				assertNoErrors(check(second, content), content)
			}
			assert.deepEqual(
				getTypeDefSymbols(second.symbols).filter(data => data.simplifiedTypeDef).length,
				0,
				'The pre-split slot has to be dropped, or a later resolution could still reach it',
			)
		})
	})
})
