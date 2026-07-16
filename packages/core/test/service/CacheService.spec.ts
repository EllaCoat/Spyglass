import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeUri } from '../../lib/index.js'
import { computeSymbolCacheName } from '../../lib/service/CacheService.js'

describe('CacheService', () => {
	describe('computeSymbolCacheName()', () => {
		// Golden test pinning the hash contract (sort + ':' join + sha1). Any change to the
		// hash material — sort order, join separator, or normalization semantics — must fail
		// here so it is made deliberately, with a matching cache migration strategy.
		it('Should produce a stable hash for a fixed canonical roots input', async () => {
			const roots = ['file:///c:/foo/', 'file:///c:/bar/']
			const expected = 'symbols/ed6fe7928facc89ef626b45e005af474456934b1.json.gz'
			assert.equal(await computeSymbolCacheName(roots), expected)
		})
		it('Should be order-independent (sort applied internally)', async () => {
			const rootsA = ['file:///c:/foo/', 'file:///c:/bar/']
			const rootsB = ['file:///c:/bar/', 'file:///c:/foo/']
			assert.equal(
				await computeSymbolCacheName(rootsA),
				await computeSymbolCacheName(rootsB),
			)
		})
		// computeSymbolCacheName() expects canonical-form roots, so URI variants are passed
		// through normalizeUri() first — mirroring what the Project constructor guarantees.
		it('Should be equivalent for URI variants after normalization', async () => {
			const variants = ['file:///C:/foo/', 'file:///c:/foo/', 'file:///C%3A/foo/']
			const results = await Promise.all(
				variants.map((v) => computeSymbolCacheName([normalizeUri(v)])),
			)
			assert.equal(results[0], results[1])
			assert.equal(results[1], results[2])
		})
	})
})
