import { type AstNode, ErrorReporter, ErrorSeverity, Failure, Source } from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import type { ImpDocAliasNode, ImpDocDeclarationNode } from '../lib/index.js'
import {
	canonicalizeLegacyDeclarationName,
	extendMcfunctionParser,
	impDoc,
	ImpDocNode,
	LEGACY_DECLARABLE_TYPES,
} from '../lib/index.js'

function fixtureUrl(name: string): URL {
	return new URL(`./fixtures/${name}`, import.meta.url)
}

async function loadFixture(name: string): Promise<string> {
	return await readFile(fixtureUrl(name), 'utf8')
}

function createParserContext(
	err: ErrorReporter,
): Parameters<typeof impDoc>[1] {
	return { err } as Parameters<typeof impDoc>[1]
}

function parseAll(content: string): { docs: ImpDocNode[]; err: ErrorReporter } {
	const src = new Source(content)
	const err = new ErrorReporter()
	const ctx = createParserContext(err)
	const docs: ImpDocNode[] = []

	while (src.canRead()) {
		src.skipWhitespace()
		if (!src.canRead()) {
			break
		}
		const prevCursor = src.cursor
		const result = impDoc(src, ctx)
		if (result === Failure) {
			assert.fail('IMP-Doc component expected')
		}
		docs.push(result)
		assert.ok(
			src.cursor > prevCursor,
			'parser must advance the cursor to prevent an infinite loop',
		)
	}
	return { docs, err }
}

async function parseFixture(name: string): Promise<{
	content: string
	doc: ImpDocNode
	err: ErrorReporter
}> {
	const content = await loadFixture(name)
	const src = new Source(content)
	const err = new ErrorReporter()
	const result = impDoc(src, createParserContext(err))
	if (result === Failure) {
		assert.fail('IMP-Doc component expected')
	}
	return { content, doc: result, err }
}

function declarationsOf(docs: readonly ImpDocNode[]): ImpDocDeclarationNode[] {
	return docs.flatMap(doc => doc.declaration?.declarations ?? [])
}

function assertTokenRanges(
	content: string,
	declarations: readonly ImpDocDeclarationNode[],
): void {
	for (const declaration of declarations) {
		assert.equal(
			content.slice(
				declaration.categoryRange.start,
				declaration.categoryRange.end,
			),
			declaration.category,
		)
		const sourceName = content.slice(
			declaration.name.range.start,
			declaration.name.range.end,
		)
		assert.equal(
			declaration.name.raw,
			canonicalizeLegacyDeclarationName(declaration.category, sourceName),
		)
	}
}

describe('IMP-Doc parser', () => {
	it('parses all five contract annotations into a lossless typed AST', async () => {
		const { content, doc, err } = await parseFixture(
			'12-contract-showcase.mcfunction',
		)
		assert.equal(err.errors.length, 0)

		assert.deepEqual(
			doc.annotations.map(annotation => annotation.type),
			[
				'impDoc:input',
				'impDoc:input',
				'impDoc:input',
				'impDoc:output',
				'impDoc:user',
				'impDoc:api',
				'impDoc:deprecated',
				'impDoc:annotation',
			],
		)
		assert.deepEqual(
			doc.contract.inputs.map(input => ({
				type: input.type,
				kind: input.kind,
				entries: input.entries.map(entry => ({
					channel: entry.channel,
					kind: entry.kind,
					target: entry.target?.raw,
					fields: entry.fields.map(field => ({
						key: field.key.raw,
						optional: field.optional,
						valueType: field.valueType?.raw,
					})),
				})),
			})),
			[
				{
					type: 'impDoc:input',
					kind: 'args',
					entries: [{
						channel: 'args',
						kind: 'args',
						target: undefined,
						fields: [
							{ key: 'Difficulty', optional: false, valueType: 'int' },
							{ key: 'Label', optional: true, valueType: 'string | text' },
						],
					}],
				},
				{
					type: 'impDoc:input',
					kind: 'as_player',
					entries: [{
						channel: 'executor',
						kind: 'as_player',
						target: 'player',
						fields: [],
					}],
				},
				{
					type: 'impDoc:input',
					kind: 'storage',
					entries: [{
						channel: 'storage',
						kind: 'storage',
						target: 'example:',
						fields: [{
							key: 'Payload',
							optional: false,
							valueType: undefined,
						}],
					}],
				},
			],
		)
		const nestedField = doc.contract.inputs[2]?.entries[0]?.fields[0]
		assert.deepEqual(
			nestedField?.children?.map(field => ({
				key: field.key.raw,
				valueType: field.valueType?.raw,
			})),
			[{ key: 'Count', valueType: 'int' }],
		)

		const [output] = doc.contract.outputs
		assert.ok(output)
		assert.deepEqual(
			output.entries.map(entry => ({
				direction: entry.direction,
				channel: entry.channel,
				target: entry.target?.raw,
				path: entry.path?.raw,
			})),
			[{
				direction: 'output',
				channel: 'tag',
				target: '@s',
				path: 'Ready',
			}],
		)
		assert.deepEqual(doc.contract.users[0]?.executor, {
			kind: 'player',
			explicit: false,
		})
		assert.equal(doc.contract.apis[0]?.audience, 'api')
		assert.equal(
			doc.contract.deprecated[0]?.message?.raw,
			'use `example:contract/v2`',
		)
		assert.equal(doc.annotations.at(-1)?.type, 'impDoc:annotation')

		for (const annotation of doc.annotations) {
			assert.equal(
				content.slice(annotation.value.range.start, annotation.value.range.end),
				annotation.value.raw,
			)
		}
		const argsField = doc.contract.inputs[0]?.entries[0]?.fields[0]
		assert.ok(argsField)
		assert.equal(
			content.slice(argsField.raw.range.start, argsField.raw.range.end),
			argsField.raw.raw,
		)
		assert.match(ImpDocNode.getDescription(doc), /@api/)
	})

	it('keeps empty and unknown contract forms parseable for preview semantics', () => {
		const content = '#> example:empty\n'
			+ '# @input\n'
			+ '# @output\n'
			+ '# @user as entity\n'
			+ '# @deprecated\n'
			+ '# @unknown custom syntax\n\n'
		const src = new Source(content)
		const err = new ErrorReporter()
		const result = impDoc(src, createParserContext(err))
		if (result === Failure) {
			assert.fail('IMP-Doc component expected')
		}

		assert.deepEqual(result.contract.inputs[0]?.entries, [])
		assert.deepEqual(result.contract.outputs[0]?.entries, [])
		const executor = result.contract.users[0]?.executor
		assert.deepEqual(
			executor && {
				kind: executor.kind,
				explicit: executor.explicit,
				raw: executor.raw?.raw,
			},
			{ kind: 'entity', explicit: true, raw: 'as entity' },
		)
		assert.equal(result.contract.deprecated[0]?.message, undefined)
		assert.equal(result.annotations.at(-1)?.type, 'impDoc:annotation')
		assert.deepEqual(err.errors, [])
	})

	it('parses the real mixed storage/executor input fixture', async () => {
		const { doc, err } = await parseFixture('09-deprecated-fn.mcfunction')
		assert.equal(err.errors.length, 0)
		const input = doc.contract.inputs[0]
		assert.ok(input)
		assert.equal(input.kind, undefined)
		assert.deepEqual(
			input.entries.map(entry => [
				entry.channel,
				entry.kind,
				entry.target?.raw,
			]),
			[
				['executor', 'as_entity', 'entity'],
				['storage', 'storage', 'lib:'],
			],
		)
		assert.deepEqual(
			input.entries[1]?.fields.map(field => [
				field.key.raw,
				field.optional,
				field.valueType?.raw,
			]),
			[
				['Argument.KnockbackResist', true, 'boolean'],
				['Argument.VectorMagnitude', false, 'double'],
			],
		)
	})

	it('parses the private function doc and its declaration block fixture', async () => {
		const content = await loadFixture('01-index-d-private.mcfunction')
		const src = new Source(content)
		const err = new ErrorReporter()
		const ctx = createParserContext(err)

		const functionDoc = impDoc(src, ctx)
		if (functionDoc === Failure) {
			assert.fail('functionDoc should not be Failure')
		}
		assert.equal(functionDoc.type, 'impDoc')
		assert.equal(functionDoc.functionID?.raw, 'api:_index.d')
		assert.deepEqual(
			ImpDocNode.flattenAnnotations(functionDoc.annotations)
				.map(values => values.map(value => value.raw)),
			[['@private']],
		)

		src.skipWhitespace()
		const declarationDoc = impDoc(src, ctx)
		if (declarationDoc === Failure) {
			assert.fail('declarationDoc should not be Failure')
		}
		assert.equal(declarationDoc.type, 'impDoc')
		assert.equal(declarationDoc.plainText, 'Public\n')
		assert.deepEqual(
			ImpDocNode.flattenAnnotations(declarationDoc.annotations)
				.map(values => values.map(value => value.raw)),
			[['@public']],
		)
		assert.deepEqual(
			declarationDoc.declaration?.lines.map(line => line.raw),
			['    #declare storage api:'],
		)
		assert.equal(err.errors.length, 0)

		const [declaration] = declarationDoc.declaration?.declarations ?? []
		assert.ok(declaration)
		const typedDeclaration: ImpDocDeclarationNode = declaration
		assert.deepEqual(
			{
				type: typedDeclaration.type,
				category: typedDeclaration.category,
				name: typedDeclaration.name.raw,
			},
			{
				type: 'impDoc:declaration',
				category: 'storage',
				name: 'api:',
			},
		)

		const declarationStart = content.indexOf('#declare storage api:')
		const categoryStart = content.indexOf('storage', declarationStart)
		const nameStart = content.indexOf('api:', declarationStart)

		assert.deepEqual(
			typedDeclaration.categoryRange,
			{ start: categoryStart, end: categoryStart + 'storage'.length },
		)
		assert.deepEqual(
			typedDeclaration.name.range,
			{ start: nameStart, end: nameStart + 'api:'.length },
		)
	})

	it('leaves an adjacent declaration doc for the next direct parse', async () => {
		const content = await loadFixture('18-adjacent-declaration-doc.mcfunction')
		const { docs, err } = parseAll(content)

		assert.deepEqual(err.errors, [])
		assert.equal(docs.length, 2)
		assert.equal(docs[0]?.functionID?.raw, 'fixture:_index.d')
		assert.equal(docs[0]?.range.end, content.indexOf('#> private'))
		assert.equal(docs[1]?.plainText, 'private\n')
		assert.deepEqual(
			declarationsOf(docs).map(node => [node.category, node.name.raw]),
			[
				['score_holder', 'RW.TargetModel'],
				['entity', '@s'],
				['tag', 'foo/bar'],
			],
		)
	})

	it('keeps an adjacent declaration doc separate through the mcfunction adapter', async () => {
		const content = await loadFixture('18-adjacent-declaration-doc.mcfunction')
		const baseParser = (src: Source): AstNode => {
			const children: AstNode[] = []
			for (const match of src.string.matchAll(/^[\t ]*#/gm)) {
				const lineStart = match.index
				const hashStart = lineStart + match[0].length - 1
				const lineEnd = src.string.indexOf('\n', hashStart)
				children.push({
					type: 'comment',
					range: {
						start: hashStart,
						end: lineEnd < 0 ? src.string.length : lineEnd,
					},
				})
			}
			src.cursor = src.string.length
			return {
				type: 'fixture:mcfunction',
				range: { start: 0, end: src.string.length },
				children,
			}
		}
		const src = new Source(content)
		const err = new ErrorReporter()
		const result = extendMcfunctionParser(baseParser)(src, createParserContext(err))
		if (result === Failure) {
			assert.fail('adapted mcfunction parse should not be Failure')
		}
		const docs = result.children?.filter(ImpDocNode.is) ?? []

		assert.deepEqual(err.errors, [])
		assert.equal(docs.length, 2)
		assert.equal(docs[0]?.functionID?.raw, 'fixture:_index.d')
		assert.deepEqual(
			declarationsOf(docs).map(node => [node.category, node.name.raw]),
			[
				['score_holder', 'RW.TargetModel'],
				['entity', '@s'],
				['tag', 'foo/bar'],
			],
		)
	})

	it('leaves an immediate command line outside the function header component', () => {
		const content = '#> example:runner\nsay hello world\n'
		const baseParser = (src: Source): AstNode => {
			const children: AstNode[] = []
			for (const match of src.string.matchAll(/^[\t ]*#/gm)) {
				const lineStart = match.index
				const hashStart = lineStart + match[0].length - 1
				const lineEnd = src.string.indexOf('\n', hashStart)
				children.push({
					type: 'comment',
					range: {
						start: hashStart,
						end: lineEnd < 0 ? src.string.length : lineEnd,
					},
				})
			}
			const sayIndex = src.string.indexOf('say ')
			if (sayIndex >= 0) {
				const sayEnd = src.string.indexOf('\n', sayIndex)
				children.push({
					type: 'command',
					range: {
						start: sayIndex,
						end: sayEnd < 0 ? src.string.length : sayEnd,
					},
				})
			}
			src.cursor = src.string.length
			return {
				type: 'fixture:mcfunction',
				range: { start: 0, end: src.string.length },
				children,
			}
		}
		const src = new Source(content)
		const err = new ErrorReporter()
		const result = extendMcfunctionParser(baseParser)(src, createParserContext(err))
		if (result === Failure) {
			assert.fail('adapted mcfunction parse should not be Failure')
		}
		const docs = result.children?.filter(ImpDocNode.is) ?? []
		const commands = (result.children ?? []).filter(child => child.type === 'command')

		assert.deepEqual(err.errors, [])
		assert.equal(docs.length, 1)
		assert.equal(docs[0]?.functionID?.raw, 'example:runner')
		assert.equal(commands.length, 1, 'immediate command line must survive at sibling level')
		assert.equal(
			commands[0]?.range.start,
			content.indexOf('say '),
			'command must not be absorbed into the function header component',
		)
	})

	it('parses the mixed Tier A fixture (tag / storage / score_holder)', async () => {
		const content = await loadFixture('02-index-d-mixed.mcfunction')
		const { docs, err } = parseAll(content)
		assert.equal(err.errors.length, 0)

		const declarations = declarationsOf(docs)
		assertTokenRanges(content, declarations)

		const counts = ['tag', 'storage', 'score_holder'].map(
			category => declarations.filter(d => d.category === category).length,
		)
		assert.deepEqual(counts, [44, 1, 1])
	})

	it('parses the storage + score_holder fixture', async () => {
		const content = await loadFixture('03-index-d-large.mcfunction')
		const { docs, err } = parseAll(content)
		assert.equal(err.errors.length, 0)

		const declarations = declarationsOf(docs)
		assertTokenRanges(content, declarations)

		assert.deepEqual(
			declarations.map(d => [d.category, d.name.raw]),
			[
				['storage', 'world_manager:nexus_loader'],
				['score_holder', '$Temp'],
				['score_holder', '$PlayerX'],
				['score_holder', '$PlayerY'],
				['score_holder', '$PlayerZ'],
				['score_holder', '$Min'],
				['score_holder', '$Max'],
			],
		)
	})

	it('parses the Tier A category showcase fixture', async () => {
		const content = await loadFixture('10-tier-a-declarations.mcfunction')
		const { docs, err } = parseAll(content)
		assert.equal(err.errors.length, 0)

		const declarations = declarationsOf(docs)
		assertTokenRanges(content, declarations)

		assert.deepEqual(
			declarations.map(d => [d.category, d.name.raw]),
			[
				['tag', 'Enemy.Boss'],
				['storage', 'example:data'],
				['score_holder', '$Counter'],
			],
		)
	})

	it('parses formerly deferred declaration categories', async () => {
		const content = await loadFixture('11-untier-a-declarations.mcfunction')
		const { docs, err } = parseAll(content)
		assert.equal(err.errors.length, 0)

		assert.deepEqual(
			declarationsOf(docs).map(node => [node.category, node.name.raw]),
			[
				['objective', 'ExampleObjective'],
				['function', 'example:run'],
				['loot_table', 'example:table'],
			],
		)
		const [, declarationDoc] = docs
		assert.deepEqual(
			declarationDoc?.declaration?.lines.map(line => line.raw),
			[
				'    #declare objective ExampleObjective',
				'    #declare function example:run',
				'    #declare loot_table example:table',
			],
		)
	})

	it('parses #declare and #define for all 55 legacy categories', async () => {
		const content = await loadFixture('14-declaration-parity.mcfunction')
		const { docs, err } = parseAll(content)
		assert.deepEqual(err.errors, [])

		const declarations = declarationsOf(docs)
		assert.equal(declarations.length, LEGACY_DECLARABLE_TYPES.length * 2)
		for (const spec of LEGACY_DECLARABLE_TYPES) {
			const matches = declarations.filter(node => node.category === spec.id)
			assert.equal(matches.length, 2, spec.id)
			assert.equal(matches[0]?.name.raw, matches[1]?.name.raw, spec.id)
		}
		assertTokenRanges(content, declarations)
	})

	it('canonicalizes omitted namespaces before declaration binding', () => {
		const content = '#> fixture:_index.d\n# @private\n\n'
			+ '#> Default namespace\n# @public\n    #define function fixture/run'
		const { docs, err } = parseAll(content)
		assert.deepEqual(err.errors, [])
		assert.equal(declarationsOf(docs)[0]?.name.raw, 'minecraft:fixture/run')
	})

	it('matches v3 canonicalization for permissive namespaced declaration IDs', () => {
		const content = '#> fixture:_index.d\n# @private\n\n'
			+ '#> Legacy namespaced spellings\n# @public\n'
			+ '    #define function #foo\n'
			+ '    #declare advancement UPPER:Thing\n'
			+ '    #declare storage :foo\n'
			+ '    #declare structure many:colon:ignored\n'
			+ '    #declare tag Foo.Bar'
		const { docs, err } = parseAll(content)
		assert.deepEqual(err.errors, [])

		assert.deepEqual(
			declarationsOf(docs).map(node => [node.category, node.name.raw]),
			[
				['function', 'minecraft:foo'],
				['advancement', 'UPPER:Thing'],
				['storage', 'minecraft:foo'],
				['structure', 'many:colon'],
				['tag', 'Foo.Bar'],
			],
		)
	})

	it('parses three v3 aliases and selectorTemplate losslessly', async () => {
		const content = await loadFixture('15-aliases.mcfunction')
		const { docs, err } = parseAll(content)
		assert.deepEqual(err.errors, [])
		const aliases = docs.flatMap(doc =>
			doc.declaration?.aliases ?? []
		) satisfies ImpDocAliasNode[]

		assert.deepEqual(
			aliases.map(node => [node.kind, node.name.raw, node.value.raw]),
			[
				['entity', 'nearest_player', '@p[tag=Ready, limit=1]'],
				['uuid', 'owner_uuid', '01234567-89ab-cdef-0123-456789abcdef'],
				['vector', 'launch_vector', '0.0 1.5 -2.0'],
				[
					'selectorTemplate',
					'hostile_selector',
					'@e[type=#fixture:hostile, distance=..16]',
				],
			],
		)
		for (const alias of aliases) {
			assert.equal(content.slice(alias.kindRange.start, alias.kindRange.end), alias.kind)
			assert.equal(content.slice(alias.name.range.start, alias.name.range.end), alias.name.raw)
			assert.equal(
				content.slice(alias.value.range.start, alias.value.range.end),
				alias.value.raw,
			)
		}
		assert.deepEqual(
			docs.flatMap(doc => doc.children ?? []).filter(node => node.type === 'impDoc:alias'),
			aliases,
		)
	})

	it('decodes quoted alias names while preserving their quoted source ranges', () => {
		const content = '#> fixture:_index.d\n# @private\n\n'
			+ '#> Quoted aliases\n# @public\n'
			+ '    #alias vector "launch vector" 0 1 2\n'
			+ "    #alias entity 'foo\\'bar' @s"
		const { docs, err } = parseAll(content)
		assert.deepEqual(err.errors, [])
		const aliases = docs.flatMap(doc => doc.declaration?.aliases ?? [])

		assert.deepEqual(
			aliases.map(node => ({
				kind: node.kind,
				key: node.name.raw,
				source: content.slice(node.name.range.start, node.name.range.end),
				expansion: node.value.raw,
			})),
			[{
				kind: 'vector',
				key: 'launch vector',
				source: '"launch vector"',
				expansion: '0 1 2',
			}, {
				kind: 'entity',
				key: "foo'bar",
				source: "'foo\\'bar'",
				expansion: '@s',
			}],
		)
	})

	it('recognizes compact and three-token spaced colon input fields', async () => {
		const { doc, err } = await parseFixture('16-contract-spaced-colon.mcfunction')
		assert.deepEqual(err.errors, [])
		assert.deepEqual(
			doc.contract.inputs[0]?.entries[0]?.fields.map(field => ({
				key: field.key.raw,
				optional: field.optional,
				valueType: field.valueType?.raw,
			})),
			[
				{ key: 'Compact', optional: false, valueType: 'int' },
				{ key: 'Spaced', optional: false, valueType: 'string | text' },
				{ key: 'Optional', optional: true, valueType: 'boolean' },
			],
		)
	})

	it('reports diagnostics for unrecognized #declare categories', () => {
		const content = '#> example:_index.d\n# @private\n\n'
			+ '#> Malformed\n# @public\n    #declare foo bar baz'
		const { docs, err } = parseAll(content)

		assert.deepEqual(declarationsOf(docs), [])
		assert.equal(err.errors.length, 1)
		const [diagnostic] = err.errors
		assert.ok(diagnostic)
		assert.equal(diagnostic.severity, ErrorSeverity.Error)
		assert.equal(
			diagnostic.message,
			'Unrecognized #declare category "foo"',
		)
		assert.equal(
			content.slice(diagnostic.range.start, diagnostic.range.end),
			'foo',
		)
	})

	it('uses the #declare diagnostic family for an unrecognized #define category', () => {
		const content = '#> example:_index.d\n# @private\n\n'
			+ '#> Malformed\n# @public\n    #define unsupported value'
		const { docs, err } = parseAll(content)

		assert.deepEqual(declarationsOf(docs), [])
		assert.equal(err.errors.length, 1)
		assert.equal(
			err.errors[0]?.message,
			'Unrecognized #declare category "unsupported"',
		)
		assert.equal(err.errors[0]?.severity, ErrorSeverity.Error)
	})
})
