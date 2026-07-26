import { showWhitespaceGlyph, testParser } from '@spyglassmc/core/test/utils.ts'
import { fail } from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RootTreeNode } from '../../lib/index.js'
import { command } from '../../lib/parser/index.js'
import { tree } from './utils.ts'

describe('mcfunction parser command()', () => {
	const cases: { content: string }[] = [
		{ content: '' },
		{ content: 's' },
		{ content: 'say' },
		{ content: 'say ' },
		{ content: 'say hi' },
		{ content: 'say hi ' },
		{ content: 'say hi garbage text' },
		{ content: 'execute if true if true run say hi' },
	]
	for (const { content } of cases) {
		it(`Parse '${showWhitespaceGlyph(content)}'`, (t) => {
			const parser = command(tree, () => undefined)
			t.assert.snapshot(testParser(parser, content))
		})
	}
	it('Should not exceed max call stack', (t) => {
		const content = `execute ${'if true '.repeat(10000)}run `
		const parser = command(tree, () => undefined)
		try {
			t.assert.snapshot({
				node: 'OMITTED',
				errors: testParser(parser, content, { noNodeReturn: true }).errors,
			})
		} catch (e) {
			fail((e as Error).stack?.slice(0, 500))
		}
	})
})

describe('mcfunction parser command() with a trailing space', () => {
	// A command tree has no `optional` flag: a node that may end a command is marked `executable`.
	// `function.id` below is modeled after the vanilla `function <id> [with ...]` command, i.e. an
	// executable node that still has children. Unlike the leaf `say.hi` of the shared tree, this is
	// the shape where a space at the end of the line used to be taken as an argument separation.
	const treeWithOptionalArgument: RootTreeNode = {
		type: 'root',
		children: {
			function: {
				type: 'literal',
				children: {
					id: {
						type: 'literal',
						executable: true,
						children: { with: { type: 'literal' } },
					},
				},
			},
		},
	}
	const cases: { content: string }[] = [
		{ content: 'function id ' },
		// Two spaces additionally cover `sep`, which reports anything but a single space.
		{ content: 'function id  ' },
		// A node that cannot end the command still reports its missing argument.
		{ content: 'function ' },
	]
	for (const { content } of cases) {
		it(`Parse '${showWhitespaceGlyph(content)}'`, (t) => {
			const parser = command(treeWithOptionalArgument, () => undefined)
			t.assert.snapshot(testParser(parser, content))
		})
	}
})
