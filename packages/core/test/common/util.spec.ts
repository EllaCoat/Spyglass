import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import type { AstNode, CommentNode, DeepReadonly, InheritReadonly } from '../../lib/index.js'
import {
	bytesToHex,
	compressBytes,
	decompressBytes,
	getSha1,
	max,
	min,
	normalizeUri,
	numericEquals,
	tryConvertToNumberWithoutPrecisionLoss,
} from '../../lib/index.js'
import { assertType, typing } from '../utils.ts'

describe('common util', () => {
	describe('normalizeUri()', () => {
		describe('Should normalize drive letters', () => {
			const Tests = [
				'file:///c:/project/readme.md',
				'file:///C:/project/readme.md',
				'file:///c%3a/project/readme.md',
				'file:///C%3a/project/readme.md',
				'file:///c%3A/project/readme.md',
				'file:///C%3A/project/readme.md',
			]
			for (const testUri of Tests) {
				it(testUri, () => {
					const actual = normalizeUri(testUri)
					assert.equal(actual, 'file:///c:/project/readme.md')
				})
			}
		})
		describe('Should noop for non-drive letters', () => {
			const Tests = [
				'file:///project/readme.md',
				'file:///project/C:/whatareyoudoinghere.md',
			]
			for (const testUri of Tests) {
				it(testUri, () => {
					const actual = normalizeUri(testUri)
					assert.equal(actual, testUri)
				})
			}
		})
		it('Should use non-encoded form of colons everywhere', () => {
			const actual = normalizeUri('file:///project/foo%3abar%3Aqux')
			assert.equal(actual, 'file:///project/foo:bar:qux')
		})

		// Characterization tests pinning the current normalization scope before Project.cacheRoot
		// and Project.projectRoots are canonicalized on construction. All URIs below are synthetic
		// so the suite behaves identically on every OS.
		describe('Should normalize URI variants of the same root to one canonical form', () => {
			const Variants = [
				'file:///C:/root/',
				'file:///c:/root/',
				'file:///C%3A/root/',
				'file:///c%3a/root/',
			]
			for (const testUri of Variants) {
				it(testUri, () => {
					assert.equal(normalizeUri(testUri), 'file:///c:/root/')
				})
			}
		})
		describe('Should not unify URIs outside the normalization scope', () => {
			it('Should keep directory casing distinct', () => {
				// Only the drive letter is lowercased; casing elsewhere in the path is untouched.
				assert.equal(normalizeUri('file:///C:/Foo/'), 'file:///c:/Foo/')
				assert.notEqual(normalizeUri('file:///C:/Foo/'), normalizeUri('file:///C:/foo/'))
			})
			it('Should keep encoded slashes distinct from path separators', () => {
				// `%3A` is the only escape sequence that is decoded; `%2F` stays encoded.
				assert.equal(normalizeUri('file:///C:/a%2Fb/'), 'file:///c:/a%2Fb/')
				assert.notEqual(normalizeUri('file:///C:/a%2Fb/'), normalizeUri('file:///C:/a/b/'))
			})
		})
		describe('Should be idempotent', () => {
			const Tests = [
				'file:///C:/root/',
				'file:///c:/root/',
				'file:///C%3A/root/',
				'file:///c%3a/root/',
				'file:///C:/a%2Fb/',
				'file:///project/readme.md',
			]
			for (const testUri of Tests) {
				it(testUri, () => {
					const normalized = normalizeUri(testUri)
					assert.equal(normalizeUri(normalized), normalized)
				})
			}
		})
		describe('Should not unify beyond the documented limits', () => {
			// normalizeUri() performs exactly two transformations: decoding `%3A`/`%3a` in the
			// pathname and lowercasing the Windows drive letter. The following identities are
			// intentionally NOT resolved by string normalization; they require filesystem-level
			// canonicalization (e.g. `realpath`) instead:
			// - `%7E` vs `~` encoding, as produced by Windows 8.3 short names such as `RUNNER~1`
			//   (see the `realpath` workaround in java-edition/test/service/CacheService.spec.ts)
			// - Unicode NFC vs NFD forms of the same visible file name
			// - symlinks pointing at the same physical directory (not expressible as URI strings)
			it('Should keep `%7E` distinct from `~`', () => {
				assert.notEqual(
					normalizeUri('file:///C:/foo%7E1/'),
					normalizeUri('file:///C:/foo~1/'),
				)
			})
			it('Should keep Unicode NFC distinct from NFD', () => {
				assert.notEqual(
					normalizeUri('file:///C:/caf\u00E9/'), // NFC: single U+00E9
					normalizeUri('file:///C:/cafe\u0301/'), // NFD: `e` + U+0301 combining accent
				)
			})
		})
	})

	typing('InheritReadonly', () => {
		type UndefinedNode = InheritReadonly<CommentNode, undefined>
		type ReadonlyNode = InheritReadonly<CommentNode, DeepReadonly<AstNode>>
		type ReadWriteNode = InheritReadonly<CommentNode, AstNode>
		assertType<never>(0 as unknown as UndefinedNode)
		assertType<DeepReadonly<CommentNode>>(0 as unknown as ReadonlyNode)
		assertType<CommentNode>(0 as unknown as ReadWriteNode)
	})

	describe('bytesToHex()', () => {
		const byteNumbers = [89, 178, 82, 105, 221, 13, 59, 38, 158, 100]
		const expectedHex = '59b25269dd0d3b269e64'

		it('Should convert Node.js Buffer to hex correctly', () => {
			const buffer = Buffer.from(byteNumbers)
			const actualHex = bytesToHex(buffer)
			assert.equal(actualHex, expectedHex)
		})

		it('Should convert bytes to hex correctly', () => {
			const bytes = new Uint8Array(byteNumbers)
			const actualHex = bytesToHex(bytes)
			assert.equal(actualHex, expectedHex)
		})

		it('Should convert bytes to hex correctly with fallback algorithm', () => {
			const toHexDescriptor = Reflect.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex')
			Reflect.deleteProperty(Uint8Array.prototype, 'toHex')
			try {
				const bytes = new Uint8Array(byteNumbers)
				const actualHex = bytesToHex(bytes)
				assert.equal(actualHex, expectedHex)
			} finally {
				if (toHexDescriptor) {
					Reflect.defineProperty(Uint8Array.prototype, 'toHex', toHexDescriptor)
				}
			}
		})

		it('Should use Uint8Array.prototype.toHex() if available', () => {
			const toHexDescriptor = Reflect.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex')
			const toHexMock = mock.fn()
			Reflect.defineProperty(Uint8Array.prototype, 'toHex', {
				configurable: true,
				enumerable: false,
				writable: true,
				value: toHexMock,
			})
			try {
				const bytes = new Uint8Array(byteNumbers)
				bytesToHex(bytes)
				assert.equal(toHexMock.mock.callCount(), 1)
			} finally {
				if (toHexDescriptor) {
					Reflect.defineProperty(Uint8Array.prototype, 'toHex', toHexDescriptor)
				} else {
					Reflect.deleteProperty(Uint8Array.prototype, 'toHex')
				}
			}
		})
	})

	describe('getSha1()', () => {
		const inputString = 'mapo tofu'
		const inputBytes = new Uint8Array([109, 97, 112, 111, 32, 116, 111, 102, 117])
		const expectedSha1 = '19bea783b6470a376530f0dbaa33b12ee9fb0df3'

		it('Should compute SHA-1 for string', async () => {
			const actualSha1 = await getSha1(inputString)
			assert.equal(actualSha1, expectedSha1)
		})

		it('Should compute SHA-1 for bytes', async () => {
			const actualSha1 = await getSha1(inputBytes)
			assert.equal(actualSha1, expectedSha1)
		})
	})

	describe('compressBytes() decompressBytes()', async () => {
		it('Should compress and decompress correctly', async () => {
			const inputBytes = new Uint8Array([109, 97, 112, 111, 32, 116, 111, 102, 117])
			const compressedBytes = await compressBytes(inputBytes, 'gzip')
			const decompressedBytes = await decompressBytes(compressedBytes, 'gzip')
			assert.deepEqual(decompressedBytes, inputBytes)
		})
	})

	describe('numericEquals()', () => {
		const suites: [number | bigint | undefined, number | bigint | undefined][] = [
			[91, 91],
			[91, 91n],
			[91n, 91n],
			[9, 1],
			[9, 1n],
			[0, undefined],
			[919191919191919191919191, 919191919191919191919191n],
			[919191919191919191919191, BigInt(919191919191919191919191)],
		]
		for (const [a, b] of suites) {
			it(`${numericToString(a)} & ${numericToString(b)}`, (t) => {
				const result = numericEquals(a, b)
				t.assert.snapshot(result)
			})
		}
	})

	describe('tryConvertToNumberWithoutPrecisionLoss()', () => {
		const suites: (number | bigint | undefined)[] = [
			91,
			91n,
			919191919191919191919191,
			919191919191919191919191n,
			undefined,
		]
		for (const n of suites) {
			it(numericToString(n) ?? 'undefined', (t) => {
				const result = tryConvertToNumberWithoutPrecisionLoss(n)
				t.assert.snapshot(numericToString(result))
			})
		}
	})

	describe('min()', () => {
		const suites: [number | bigint, number | bigint][] = [
			[91, 91],
			[9, 1],
			[1, 9],
			[9, 1n],
			[9n, 1],
		]
		for (const [a, b] of suites) {
			it(`${numericToString(a)} & ${numericToString(b)}`, (t) => {
				const result = min(a, b)
				t.assert.snapshot(numericToString(result))
			})
		}
	})

	describe('max()', () => {
		const suites: [number | bigint, number | bigint][] = [
			[91, 91],
			[9, 1],
			[1, 9],
			[9, 1n],
			[9n, 1],
		]
		for (const [a, b] of suites) {
			it(`${numericToString(a)} & ${numericToString(b)}`, (t) => {
				const result = max(a, b)
				t.assert.snapshot(numericToString(result))
			})
		}
	})
})

function numericToString(n: number | bigint | undefined) {
	return typeof n === 'bigint' ? `${n}n` : n?.toString()
}
