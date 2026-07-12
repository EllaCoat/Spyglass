import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { ImpDocVersion } from '../lib/version.js'

describe('ImpDocVersion vs package.json version', () => {
	it('matches package.json version to force bump discipline', () => {
		const pkgUrl = new URL('../package.json', import.meta.url)
		const pkg = JSON.parse(readFileSync(pkgUrl, 'utf-8')) as {
			version: string
		}
		assert.equal(
			ImpDocVersion,
			pkg.version,
			`ImpDocVersion (${ImpDocVersion}) must match package.json version (${pkg.version}). `
				+ `Bump both together to keep cache invalidation coherent.`,
		)
	})
})
