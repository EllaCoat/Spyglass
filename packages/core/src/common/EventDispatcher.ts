import { Dev } from './Dev.js'

class AwaitableCustomEvent<T> extends CustomEvent<T> {
	readonly promises: Promise<unknown>[] = []

	waitUntil(result: unknown): void {
		this.promises.push(Promise.resolve(result))
	}
}

export class EventDispatcher<TEvents extends Record<string, unknown>> {
	readonly #target = new EventTarget()

	emit<K extends keyof TEvents & string>(name: K, data: TEvents[K]): void {
		this.#target.dispatchEvent(new CustomEvent(name, { detail: data }))
	}

	async emitAsync<K extends keyof TEvents & string>(name: K, data: TEvents[K]): Promise<void> {
		const event = new AwaitableCustomEvent(name, { detail: data })
		this.#target.dispatchEvent(event)
		await Promise.all(event.promises)
	}

	on<K extends keyof TEvents & string>(
		name: K,
		listener: (data: TEvents[K]) => unknown,
		options?: AddEventListenerOptions,
	): this {
		this.#target.addEventListener(name, (event) => {
			Dev.assertTrue(event instanceof CustomEvent, 'event must be an instance of CustomEvent')
			try {
				const result = listener(event.detail)
				if (event instanceof AwaitableCustomEvent) {
					event.waitUntil(result)
				}
			} catch (e) {
				if (event instanceof AwaitableCustomEvent) {
					event.waitUntil(Promise.reject(e))
					return
				}
				throw e
			}
		}, options)
		return this
	}
}
