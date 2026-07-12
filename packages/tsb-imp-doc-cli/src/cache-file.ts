import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
	try {
		await mkdir(dirname(path), { recursive: true })
		tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
		await writeFile(tempPath, content, { flag: 'wx' })

		// Revalidate only after the payload is ready, immediately before the
		// atomic rename, so stale work cannot knowingly replace a newer cache.
		if (await readCacheToken(path) !== expectedToken) {
			return false
		}
		await rename(tempPath, path)
		tempPath = undefined
		return true
	} catch {
		// A cache write failure must never change the lint result.
		return false
	} finally {
		if (tempPath !== undefined) {
			await rm(tempPath, { force: true }).catch(() => {})
		}
	}
}
