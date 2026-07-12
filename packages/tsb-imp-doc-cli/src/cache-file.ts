import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const LockRetryCount = 500
const LockRetryDelayMs = 10

/** Returns a token for the exact bytes stored in the cache file. */
export function rawCacheToken(raw: Uint8Array): string {
	return createHash('sha1').update(raw).digest('hex')
}

export async function readCacheToken(path: string): Promise<string | undefined> {
	try {
		return rawCacheToken(await readFile(path))
	} catch {
		return undefined
	}
}

function isFileExistsError(error: unknown): boolean {
	return !!error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
}

async function acquireCacheLock(path: string): Promise<(() => Promise<void>) | undefined> {
	const lockPath = `${path}.lock`
	for (let attempt = 0; attempt < LockRetryCount; attempt += 1) {
		let acquired = false
		try {
			const handle = await open(lockPath, 'wx')
			acquired = true
			try {
				await handle.writeFile(`${process.pid}:${randomUUID()}`)
				await handle.sync()
			} finally {
				await handle.close()
			}
			return async () => {
				await rm(lockPath, { force: true })
			}
		} catch (e) {
			if (acquired) {
				await rm(lockPath, { force: true }).catch(() => {})
			}
			if (!isFileExistsError(e)) {
				throw e
			}
			await new Promise<void>(resolve => setTimeout(resolve, LockRetryDelayMs))
		}
	}
	return undefined
}

async function syncParentDirectory(path: string): Promise<void> {
	const handle = await open(dirname(path), 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

/**
 * Atomically replaces a cache file if its raw-byte token still matches the
 * snapshot used to produce the replacement.
 */
export async function writeCacheAtomically(
	path: string,
	expectedToken: string | undefined,
	content: string,
): Promise<boolean> {
	let tempPath: string | undefined
	let releaseLock: (() => Promise<void>) | undefined
	try {
		await mkdir(dirname(path), { recursive: true })
		tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
		await writeFile(tempPath, content, { flag: 'wx' })

		// Serialize token validation and publication. A rename is atomic by itself, but without
		// this lock two writers can both validate the same token before either rename occurs.
		releaseLock = await acquireCacheLock(path)
		if (!releaseLock) {
			return false
		}
		if (await readCacheToken(path) !== expectedToken) {
			return false
		}
		await rename(tempPath, path)
		tempPath = undefined
		await syncParentDirectory(path)
		return true
	} catch {
		// A cache write failure must never change the lint result.
		return false
	} finally {
		if (releaseLock !== undefined) {
			await releaseLock().catch(() => {})
		}
		if (tempPath !== undefined) {
			await rm(tempPath, { force: true }).catch(() => {})
		}
	}
}
