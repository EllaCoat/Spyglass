import { memfs } from 'memfs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Externals, RootUriString, UriProtocolSupporter } from '../../lib/index.js'
import { FileServiceImpl } from '../../lib/service/FileService.js'
import { mockExternals } from '../utils.ts'

const VirtualUri = 'test:pack/foo.mcfunction'
const UppercaseRoot: RootUriString = 'file:///C:/cache/virtual-uris/'
const LowercaseRoot: RootUriString = 'file:///c:/cache/virtual-uris/'
const StubContent = new Uint8Array([109, 101, 111, 119])

function createStubSupporter(): UriProtocolSupporter {
	return {
		async hash() {
			return 'da39a3ee5e6b4b0d3255bfef95601890afd80709'
		},
		async readFile() {
			return StubContent
		},
		*listFiles() {},
		*listRoots() {},
	}
}

function createFileService(
	virtualUrisRoot: RootUriString | undefined,
): { fileService: FileServiceImpl; externals: Externals } {
	const rawExternals = mockExternals({ nodeFsp: memfs({}, '/').fs.promises })
	const externals: Externals = {
		...rawExternals,
		fs: {
			...rawExternals.fs,
			// memfs enforces mode bits even on the `open()` call that creates the file, unlike
			// POSIX where the creating fd may write regardless of the new file's mode.
			// FileServiceImpl writes mapped files with mode 0o444, so drop the mode here.
			writeFile(location, data) {
				return rawExternals.fs.writeFile(location, data)
			},
		},
	}
	const fileService = new FileServiceImpl(externals, virtualUrisRoot)
	fileService.register('test:', createStubSupporter())
	return { fileService, externals }
}

describe('FileService', () => {
	describe('mapToDisk()', () => {
		it('Should normalize an uppercase drive letter in virtualUrisRoot to lowercase (#1483)', async () => {
			const { fileService, externals } = createFileService(UppercaseRoot)
			const mappedUri = await fileService.mapToDisk(VirtualUri)
			assert.ok(mappedUri)
			assert.ok(
				mappedUri.startsWith('file:///c:/'),
				`Expected '${mappedUri}' to start with 'file:///c:/'`,
			)
			// Sanity check that the success path actually ran and wrote the mapped file.
			assert.deepEqual(
				new Uint8Array(await externals.fs.readFile(mappedUri)),
				StubContent,
			)
		})

		it('Should return the identical mapped URI on repeated calls', async () => {
			const { fileService } = createFileService(UppercaseRoot)
			const first = await fileService.mapToDisk(VirtualUri)
			const second = await fileService.mapToDisk(VirtualUri)
			assert.ok(first)
			assert.strictEqual(second, first)
		})

		it('Should produce the same mapped URI regardless of the casing of the constructor root', async () => {
			const fromUppercaseRoot = await createFileService(UppercaseRoot)
				.fileService.mapToDisk(VirtualUri)
			const fromLowercaseRoot = await createFileService(LowercaseRoot)
				.fileService.mapToDisk(VirtualUri)
			assert.ok(fromUppercaseRoot)
			assert.strictEqual(fromLowercaseRoot, fromUppercaseRoot)
		})

		it('Should pass file: URIs through and return undefined otherwise when virtualUrisRoot is undefined', async () => {
			const { fileService } = createFileService(undefined)
			assert.strictEqual(
				await fileService.mapToDisk('file:///root/foo.mcfunction'),
				'file:///root/foo.mcfunction',
			)
			assert.strictEqual(await fileService.mapToDisk(VirtualUri), undefined)
		})
	})

	describe('mapFromDisk()', () => {
		it('Should look up a mapped URI whose drive letter casing was flipped (#1483)', async () => {
			const { fileService } = createFileService(UppercaseRoot)
			const mappedUri = await fileService.mapToDisk(VirtualUri)
			assert.ok(mappedUri)
			const uppercasedUri = mappedUri.replace('file:///c:/', 'file:///C:/')
			assert.notStrictEqual(uppercasedUri, mappedUri)
			assert.strictEqual(fileService.mapFromDisk(uppercasedUri), VirtualUri)
		})

		it('Should look up a mapped URI in its canonical lowercase form', async () => {
			const { fileService } = createFileService(UppercaseRoot)
			const mappedUri = await fileService.mapToDisk(VirtualUri)
			assert.ok(mappedUri)
			assert.strictEqual(fileService.mapFromDisk(mappedUri), VirtualUri)
		})

		it('Should return unmapped URIs unchanged with their original casing', () => {
			const { fileService } = createFileService(UppercaseRoot)
			assert.strictEqual(
				fileService.mapFromDisk('file:///Z:/never/mapped/file.txt'),
				'file:///Z:/never/mapped/file.txt',
			)
		})

		it('Should return the input unchanged when virtualUrisRoot is undefined', () => {
			const { fileService } = createFileService(undefined)
			assert.strictEqual(
				fileService.mapFromDisk('file:///C:/never/mapped/file.txt'),
				'file:///C:/never/mapped/file.txt',
			)
		})
	})
})
