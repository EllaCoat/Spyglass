import { ErrorReporter, Failure, Source } from '@spyglassmc/core'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { impDoc, ImpDocNode, parseVisibility } from '../lib/index.js'

describe('Legacy DHP v3.4.19 contract characterization', () => {
	it('@user is displayed and retained as a player executor contract without bulk diagnostics', async () => {
		const content = await readFile(
			new URL('./fixtures/07-user-fn.mcfunction', import.meta.url),
			'utf8',
		)
		const err = new ErrorReporter()
		const result = impDoc(
			new Source(content),
			{
				err,
			} as Parameters<typeof impDoc>[1],
		)
		if (result === Failure) {
			assert.fail('IMP-Doc component expected')
		}

		// Legacy DocCommentPlugin flattened and displayed @user, but its parser
		// did not emit an executor/call-graph diagnostic. P2a preserves that
		// behavior while recording the TSB executor convention structurally.
		assert.deepEqual(
			ImpDocNode.flattenAnnotations(result.annotations)
				.map(values => values.map(value => value.raw)),
			[['@private'], ['@user']],
		)
		assert.match(ImpDocNode.getDescription(result), /@user/)
		assert.deepEqual(result.contract.users[0]?.executor, {
			kind: 'player',
			explicit: false,
		})
		assert.deepEqual(
			parseVisibility(result.annotations, 'debug:clear_lostitems', err),
			{ type: 'private', owner: 'debug:clear_lostitems' },
		)
		assert.deepEqual(err.errors, [])
	})

	it('keeps @user and @input as player as parallel structured markers', async () => {
		const content = await readFile(
			new URL('./fixtures/12-contract-showcase.mcfunction', import.meta.url),
			'utf8',
		)
		const err = new ErrorReporter()
		const result = impDoc(
			new Source(content),
			{
				err,
			} as Parameters<typeof impDoc>[1],
		)
		if (result === Failure) {
			assert.fail('IMP-Doc component expected')
		}

		assert.equal(result.contract.users[0]?.executor.kind, 'player')
		assert.equal(result.contract.inputs[1]?.kind, 'as_player')
		assert.equal(result.contract.inputs[1]?.entries[0]?.channel, 'executor')
		assert.deepEqual(err.errors, [])
	})
})
