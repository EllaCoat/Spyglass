import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const WindowsFsRetryCount = 5
const WindowsFsRetryDelayMs = 20

const WindowsRetryableCodes = new Set([
	'EACCES',
	'EBUSY',
	'EPERM',
])

type TokenProbe =
	| { ok: true; token: string | undefined }
	| { ok: false }

/**
 * Completion gates for writes targeting the same path in this process.
 *
 * This is intentionally not an inter-process lock. Separate CLI processes may
 * both publish; because publication uses a same-directory rename, the result
 * remains a complete cache file and the last publisher wins.
 */
const cacheWriteTails = new Map<string, Promise<void>>()

/** Returns a token for the exact bytes stored in the cache file. */
export function rawCacheToken(raw: Uint8Array): string {
	return createHash('sha1').update(raw).digest('hex')
}

function errorCode(error: unknown): string | undefined {
	if (
		error !== null
		&& typeof error === 'object'
		&& 'code' in error
		&& typeof error.code === 'string'
	) {
		return error.code
	}
	return undefined
}

/**
 * Distinguishes an absent cache from a cache that could not be read.
 *
 * Treating EACCES or EBUSY as "absent" could overwrite a file whose token was
 * never validated, so comparison fails closed for those errors.
 */
async function probeCacheToken(path: string): Promise<TokenProbe> {
	try {
		return {
			ok: true,
			token: rawCacheToken(await readFile(path)),
		}
	} catch (error) {
		if (errorCode(error) === 'ENOENT') {
			return { ok: true, token: undefined }
		}
		return { ok: false }
	}
}

export async function readCacheToken(path: string): Promise<string | undefined> {
	const result = await probeCacheToken(path)
	return result.ok ? result.token : undefined
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolveDelay => {
		setTimeout(resolveDelay, milliseconds)
	})
}

/**
 * Retries transient Windows sharing violations with a short linear backoff.
 *
 * Five retries wait for at most 300 ms in total:
 * 20 + 40 + 60 + 80 + 100.
 */
async function retryWindowsFsOperation<T>(
	operation: () => Promise<T>,
): Promise<T> {
	let retries = 0

	for (;;) {
		try {
			return await operation()
		} catch (error) {
			const retryable = process.platform === 'win32'
				&& WindowsRetryableCodes.has(errorCode(error) ?? '')

			if (!retryable || retries >= WindowsFsRetryCount) {
				throw error
			}

			retries += 1
			await delay(WindowsFsRetryDelayMs * retries)
		}
	}
}

async function renameReplacing(
	tempPath: string,
	cachePath: string,
): Promise<void> {
	await retryWindowsFsOperation(() => rename(tempPath, cachePath))
}

async function removeTemporaryFile(tempPath: string): Promise<void> {
	await retryWindowsFsOperation(
		() => rm(tempPath, { force: true }),
	).catch(() => {
		// Cache cleanup is best-effort. There must be no unbounded retry loop.
	})
}

/**
 * Runs an action after all earlier writes for the same resolved path.
 *
 * The tail is independent of the action result, so an exception cannot poison
 * the queue. The identity check prevents an older action from deleting a newer
 * action's tail.
 */
async function serializeCacheWrite<T>(
	path: string,
	action: (absolutePath: string) => Promise<T>,
): Promise<T> {
	const absolutePath = resolve(path)
	const key = process.platform === 'win32'
		? absolutePath.toLowerCase()
		: absolutePath

	const previous = cacheWriteTails.get(key) ?? Promise.resolve()

	let releaseGate!: () => void
	const gate = new Promise<void>(resolveGate => {
		releaseGate = resolveGate
	})
	const tail = previous.then(() => gate)

	cacheWriteTails.set(key, tail)
	await previous

	try {
		return await action(absolutePath)
	} finally {
		releaseGate()
		if (cacheWriteTails.get(key) === tail) {
			cacheWriteTails.delete(key)
		}
	}
}

/**
 * Performs a process-local token compare-and-swap and publishes through a
 * same-directory rename.
 *
 * Returns true only after this invocation's rename succeeds. Separate
 * processes are intentionally not serialized; they may both return true.
 */
export async function writeCacheAtomically(
	path: string,
	expectedToken: string | undefined,
	content: string,
): Promise<boolean> {
	return serializeCacheWrite(path, async cachePath => {
		let tempPath: string | undefined

		try {
			await mkdir(dirname(cachePath), { recursive: true })

			const current = await probeCacheToken(cachePath)
			if (!current.ok || current.token !== expectedToken) {
				return false
			}

			// Keep the temporary file beside the destination. Cross-volume
			// rename is not atomic and can fail with EXDEV.
			tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`

			await writeFile(tempPath, content, { flag: 'wx' })
			await renameReplacing(tempPath, cachePath)

			// Rename is the commit point. Do no further fallible durability
			// work before returning success.
			tempPath = undefined
			return true
		} catch {
			// Cache failures must not alter the lint result.
			return false
		} finally {
			if (tempPath !== undefined) {
				await removeTemporaryFile(tempPath)
			}
		}
	})
}
