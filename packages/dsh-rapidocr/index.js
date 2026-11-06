// @local/dsh-rapidocr — Host-only bundle.
//
// Registers one model-facing tool, `ocr_image`, that recognises the text in a
// local image file with the bundled CPU OCR engine.
//
// The image bytes are read through the mounted filesystem backend (`ctx.fs`),
// so path authorisation stays with the filesystem provider, and are piped to a
// long-lived Node sidecar over stdin. Nothing is uploaded and no network call
// is made.
//
// Verified against DeepSeek Harness Desktop 0.2.2-rc.1 (Electron 44.7.0,
// Node 24.21.0). Every DSH API call below carries a citation.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Every runtime dependency is vendored, so the bundle resolves them from its
// own directory instead of relying on the profile's hoisted copies. Schemastery
// is used for the config schema because the Settings UI renders a native
// editor for a Schemastery graph.
import Schema from './vendor/node_modules/@deepseek-ai/schemastery/lib/index.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rapidocr'

/**
 * Services this plugin requires.
 * - 'tools'            -> ctx.tools            (tool registry)
 * - 'workingDirectory' -> ctx.workingDirectory (the session working directory)
 * - 'fs'               -> ctx.fs               (path authorisation, byte reads)
 * - 'subprocess'       -> ctx.subprocess       (the long-lived OCR sidecar)
 *
 * `systemPrompt` is deliberately NOT a hard dependency: the model-facing hint
 * is registered through `ctx.inject(['systemPrompt'], …)` so the tool still
 * works in a profile without the prompt registry — the same optional-service
 * pattern `dsh-tool-fs` uses for `attachments`
 * (`dsh-tool-fs/lib/index.js:1980-1982`).
 */
export const inject = ['tools', 'workingDirectory', 'fs', 'subprocess']

/**
 * Config schema for the plugin row.
 *
 * The loader validates the row's `config` against this export through the
 * Standard Schema interface (`runtime.Config['~standard'].validate(config)`,
 * `cordis/lib/index.js:244-250`), which Schemastery implements
 * (`schemastery/lib/index.cjs:52`). A Schemastery graph is also the native
 * form the Settings UI renders a config editor for.
 */
export const Config = Schema.object({
	/** Register the `ocr_image` tool at all. */
	enabled: Schema.boolean().default(true),
	/** Per-call tool timeout handed to the registry. */
	timeoutMs: Schema.number().default(120000),
	/** Hard cap on the image size read through `ctx.fs`. */
	maxImageBytes: Schema.number().default(52428800),
	/**
	 * Hard cap on the decoded pixel count (`width * height`).
	 *
	 * The byte cap alone does not bound memory: a 50 MiB PNG can decode into
	 * tens of GB of RGB. 40,000,000 pixels is ~120 MB of RGB, well above an
	 * A4 page at 300 dpi (~8.7 MP) and a 1920x1080 screenshot (~2.1 MP).
	 */
	maxPixels: Schema.number().default(40000000),
	/** Maximum number of recognised characters returned to the model. */
	maxTextChars: Schema.number().default(20000),
	/** How long to wait for the sidecar's `ready` line. */
	startTimeoutMs: Schema.number().default(30000),
})

/** Default cap on the bytes retained from the sidecar's stderr stream. */
const MAX_LOG_BYTES = 64 * 1024
/** Grace period the subprocess provider gets to shut the sidecar down. */
const GRACE_MS = 5000
/**
 * Placement of the `tool:ocr_image` prompt section.
 *
 * `ctx.systemPrompt.getSectionOrder(name)` only resolves the names in the
 * centrally owned `SECTION_ORDERS` table
 * (`dsh-system-prompt/lib/index.js:10-45`), and that table has no
 * `TOOL_OCR_IMAGE` entry — `section()` rejects a non-finite order
 * (`dsh-system-prompt/lib/index.js:255-258`), so a literal is used instead.
 * 1150 sits between `TOOL_READ` (1100) and `TOOL_WRITE` (1200).
 */
const OCR_SECTION_ORDER = 1150
/** PNG signature — `src/image.js:18`. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** JPEG signature — `src/image.js:19`. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/**
 * Detect the container of an image from its leading bytes.
 *
 * The format is sniffed from the content, never from the file name, and only
 * PNG and JPEG are accepted — the decoder supports exactly those two
 * (`src/image.js:142-158`).
 * @param {Uint8Array} bytes - the raw file content.
 * @returns {string | undefined} the media type, or undefined when unsupported.
 */
function sniffImageMediaType(bytes) {
	const buffer = Buffer.isBuffer(bytes)
		? bytes
		: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png'
	if (buffer.length >= JPEG_MAGIC.length && buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg'
	return undefined
}

/**
 * Resolve the sidecar script that ships inside this bundle.
 *
 * Package-relative resolution is the in-tree pattern
 * (`dsh-experimental-speech-to-text-sensevoice/lib/index.js:218`:
 * `fileURLToPath(new URL('./worker.js', import.meta.url))`).
 *
 * The path is deliberately not configurable: the sidecar is always the script
 * shipped inside this package, so nothing can point the subprocess at an
 * arbitrary file on disk.
 * @returns {string} an absolute path to the worker script.
 */
function resolveWorkerPath() {
	const candidate = fileURLToPath(new URL('./worker/ocr-worker.js', import.meta.url))
	if (!existsSync(candidate)) throw new Error(`rapidocr: OCR worker script not found at ${candidate}`)
	return candidate
}

/**
 * One live sidecar: the child process plus the JSON-Lines framing on top of it.
 *
 * The sidecar speaks one JSON object per line on stdout. It prints
 * `{"event":"ready",…}` once the ONNX models are loaded and answers every
 * request with a line carrying the request `id`. Requests are correlated by
 * that id, so several calls may share one warm process.
 */
class OcrSidecar {
	/**
	 * @param {object} ctx - the plugin context providing `subprocess`.
	 * @param {object} options - the resolved sidecar options.
	 */
	constructor(ctx, options) {
		this.ctx = ctx
		this.workerPath = options.workerPath
		this.startTimeoutMs = options.startTimeoutMs
		this.cwd = options.cwd
		/** Extra environment entries handed to the sidecar. */
		this.env = options.env ?? {}
		/** The live handle, or undefined while no sidecar runs. */
		this.handle = undefined
		/** In-flight start, shared by concurrent callers. */
		this.starting = undefined
		/** Pending request id -> resolver. */
		this.pending = new Map()
		/** Partial stdout line carried across chunk boundaries. */
		this.buffer = ''
		/** Resolver for the `ready` event. */
		this.onReady = undefined
		/** Set once the child exited or failed to start. */
		this.exited = false
		/** Disposer registered on the plugin context for the running child. */
		this.contextEffect = undefined
	}

	/**
	 * Return a live sidecar, starting one on first use.
	 *
	 * The model load (~410 ms) is paid once: the child stays warm across calls
	 * and is only replaced after an unexpected exit. Concurrent callers share
	 * one start.
	 * @param {AbortSignal} signal - cancellation for the start.
	 * @returns {Promise<OcrSidecar>} the live sidecar.
	 */
	async ensure(signal) {
		if (this.handle !== undefined && !this.exited) {
			this.probe()
			return this
		}
		if (this.starting === undefined) {
			const pending = this.start(signal)
			this.starting = pending
			const clear = () => {
				if (this.starting === pending) this.starting = undefined
			}
			pending.then(clear, clear)
		}
		await this.starting
		return this
	}

	/**
	 * Spawn the sidecar and wait for its `ready` line.
	 * @param {AbortSignal} signal - cancellation for the start.
	 * @returns {Promise<void>} resolves once the worker announced readiness.
	 */
	async start(signal) {
		if (signal.aborted) throw new Error('rapidocr: the OCR request was cancelled before the sidecar started')
		this.exited = false
		this.buffer = ''
		let handle
		try {
			handle = this.ctx.subprocess.spawn({
				argv: [process.execPath, this.workerPath],
				cwd: this.cwd,
				graceMs: GRACE_MS,
				// `ELECTRON_RUN_AS_NODE` turns the Host's own Electron binary into a
				// plain Node runtime for the child
				// (dsh-experimental-speech-to-text-sensevoice/lib/index.js:782-785).
				env: { ELECTRON_RUN_AS_NODE: '1', ...this.env },
				stdio: {
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: { maxBytes: MAX_LOG_BYTES },
				},
			})
		} catch (error) {
			this.exited = true
			throw new Error(`rapidocr: the OCR sidecar could not be started: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
		}
		this.handle = handle

		const ready = new Promise((resolve, reject) => {
			this.onReady = { resolve, reject }
		})
		const timer = setTimeout(() => {
			const waiter = this.onReady
			this.onReady = undefined
			waiter?.reject(new Error(`rapidocr: the OCR sidecar did not become ready within ${this.startTimeoutMs} ms${this.stderrTail()}`))
		}, this.startTimeoutMs)

		const stdout = handle.stdout
		if (stdout === undefined) {
			clearTimeout(timer)
			this.onReady = undefined
			await this.stop()
			throw new Error('rapidocr: the OCR sidecar produced no stdout stream')
		}
		stdout.setEncoding('utf8')
		stdout.on('data', (chunk) => this.consume(chunk))
		stdout.on('error', (error) => this.failAll(error))
		stdout.on('end', () => this.failAll(new Error('rapidocr: the OCR sidecar closed its stdout stream')))

		const stdin = handle.stdin
		if (stdin !== undefined) stdin.on('error', (error) => this.failAll(error))

		const exited = () => {
			this.exited = true
			this.failAll(new Error(`rapidocr: the OCR sidecar exited unexpectedly${this.stderrTail()}`))
		}
		handle.done.then(exited, exited)

		// Own the child on the plugin context so a plugin unload terminates it
		// even when the lazy start happened after `apply` returned.
		try {
			this.contextEffect = this.ctx.effect(() => () => this.shutdown(handle))
		} catch {
			// The context was already disposed; the disposer returned from
			// `apply` still terminates the child.
		}

		try {
			await ready
		} catch (error) {
			clearTimeout(timer)
			await this.stop()
			throw error
		}
		clearTimeout(timer)
	}

	/**
	 * Send the worker's liveness probe without waiting for its answer.
	 *
	 * The probe is fire-and-forget: a broken pipe surfaces as a write error
	 * and means the child is gone, while a delayed answer only means the
	 * worker is busy with an earlier request.
	 * @returns {void}
	 */
	probe() {
		const stdin = this.handle?.stdin
		if (stdin === undefined) return
		try {
			stdin.write(`${JSON.stringify({ id: randomUUID(), op: 'ping' })}\n`)
		} catch {
			// A broken pipe is reported by the request itself.
		}
	}

	/**
	 * Consume one stdout chunk and dispatch every complete line.
	 * @param {string} chunk - the decoded stdout chunk.
	 * @returns {void}
	 */
	consume(chunk) {
		this.buffer += chunk
		let index = this.buffer.indexOf('\n')
		while (index >= 0) {
			const line = this.buffer.slice(0, index)
			this.buffer = this.buffer.slice(index + 1)
			this.dispatch(line)
			index = this.buffer.indexOf('\n')
		}
	}

	/**
	 * Handle one protocol line.
	 * @param {string} line - one JSON-Lines record.
	 * @returns {void}
	 */
	dispatch(line) {
		const trimmed = line.trim()
		if (trimmed.length === 0) return
		let message
		try {
			message = JSON.parse(trimmed)
		} catch {
			// Not a protocol line; the worker keeps stdout free of noise, so
			// anything unparsable is ignored rather than fatal.
			return
		}
		if (message === null || typeof message !== 'object') return
		if (message.event === 'ready') {
			this.onReady?.resolve(message)
			this.onReady = undefined
			return
		}
		const id = message.id
		if (typeof id !== 'string') return
		const waiter = this.pending.get(id)
		if (waiter === undefined) return
		this.pending.delete(id)
		waiter(message)
	}

	/**
	 * Reject every in-flight request.
	 * @param {Error} error - the failure shared by the pending requests.
	 * @returns {void}
	 */
	failAll(error) {
		if (this.onReady !== undefined) {
			this.onReady.reject(error)
			this.onReady = undefined
		}
		for (const waiter of this.pending.values()) waiter({ ok: false, error: error.message, transport: true })
		this.pending.clear()
	}

	/**
	 * The retained tail of the sidecar's stderr stream, for diagnostics.
	 * @returns {string} a short suffix, or an empty string.
	 */
	stderrTail() {
		try {
			const text = this.handle?.collected?.stderr?.readFrom?.(0)?.text
			if (typeof text !== 'string' || text.trim().length === 0) return ''
			return `: ${text.trim().split(/\r?\n/).slice(-3).join(' | ')}`
		} catch {
			return ''
		}
	}

	/**
	 * Send one request and await the answer carrying the same id.
	 * @param {object} payload - the request record, including its `id`.
	 * @param {AbortSignal} signal - cancellation for this request.
	 * @returns {Promise<object>} the worker's response record.
	 */
	request(payload, signal) {
		const id = payload.id
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.pending.delete(id)
				signal.removeEventListener('abort', onAbort)
			}
			const onAbort = () => {
				cleanup()
				reject(new Error('rapidocr: the OCR request was cancelled'))
			}
			if (signal.aborted) {
				onAbort()
				return
			}
			signal.addEventListener('abort', onAbort, { once: true })
			this.pending.set(id, (message) => {
				cleanup()
				if (message.ok === false) {
					const error = new Error(`rapidocr: OCR failed: ${message.error ?? 'unknown error'}`)
					if (message.transport === true) error.transport = true
					reject(error)
					return
				}
				resolve(message)
			})
			const stdin = this.handle?.stdin
			if (stdin === undefined) {
				cleanup()
				const error = new Error('rapidocr: the OCR sidecar exposes no stdin stream')
				error.transport = true
				reject(error)
				return
			}
			try {
				stdin.write(`${JSON.stringify(payload)}\n`)
			} catch (error) {
				cleanup()
				const failure = new Error(`rapidocr: the OCR request could not be written to the sidecar: ${error instanceof Error ? error.message : String(error)}`)
				failure.transport = true
				reject(failure)
			}
		})
	}

	/**
	 * Stop one child process gracefully.
	 *
	 * libuv terminates a Windows child unconditionally, so a signal can never
	 * be delivered there and `terminate()` is destructive. The worker exits
	 * with code 0 once its stdin reaches EOF, so the stream is closed first
	 * and the forced termination is only the fallback for a child that
	 * ignores the EOF.
	 * @param {object | undefined} handle - the handle to stop.
	 * @returns {Promise<void>} resolves once the child is gone.
	 */
	async shutdown(handle) {
		if (handle === undefined) return
		try {
			handle.stdin?.end()
		} catch {}
		const exited = handle.waitForExit().then(() => true, () => true)
		const grace = new Promise((resolve) => {
			setTimeout(() => resolve(false), GRACE_MS)
		})
		if (await Promise.race([exited, grace])) return
		try {
			handle.terminate()
		} catch {}
		await exited
	}

	/**
	 * Terminate the sidecar and await its exit.
	 * @returns {Promise<void>} resolves once the child is gone.
	 */
	async stop() {
		const handle = this.handle
		this.handle = undefined
		this.exited = true
		this.starting = undefined
		this.failAll(new Error('rapidocr: the OCR sidecar was shut down'))
		await this.shutdown(handle)
	}

	/**
	 * Terminate the sidecar and release everything it owns.
	 * @returns {Promise<void>} resolves once the child is gone.
	 */
	async dispose() {
		if (this.contextEffect !== undefined) {
			const effect = this.contextEffect
			this.contextEffect = undefined
			try {
				await effect()
			} catch {}
		}
		await this.stop()
	}
}

/**
 * Run one recognition against the warm sidecar, respawning once if the child
 * died underneath the request.
 * @param {OcrSidecar} sidecar - the owned sidecar.
 * @param {object} request - the OCR request payload.
 * @param {AbortSignal} signal - cancellation for the request.
 * @returns {Promise<object>} the worker's response record.
 */
async function recognise(sidecar, request, signal) {
	const attempt = async () => {
		const live = await sidecar.ensure(signal)
		return await live.request(request, signal)
	}
	try {
		return await attempt()
	} catch (error) {
		const transport = error instanceof Error && error.transport === true
		if (!transport || signal.aborted) throw error
		// The child died underneath us: replace it and try once more so the
		// next call finds a warm engine again.
		await sidecar.stop()
		return await attempt()
	}
}

/**
 * Normalise the worker's answer into the tool's output value.
 * @param {object} message - the worker's response record.
 * @param {string} path - the canonical path of the recognised image.
 * @param {number} elapsedMs - the wall time of the OCR round trip.
 * @param {number} maxTextChars - the character budget for the recognised text.
 * @returns {{ path: string, text: string, lines: object[], elapsedMs: number }} the output value.
 */
function toOutputValue(message, path, elapsedMs, maxTextChars) {
	const raw = Array.isArray(message.lines) ? message.lines : []
	const lines = []
	let used = 0
	for (const entry of raw) {
		const text = typeof entry?.text === 'string' ? entry.text : ''
		if (lines.length > 0 && used + text.length > maxTextChars) break
		const box = Array.isArray(entry?.box)
			? entry.box.map((point) => (Array.isArray(point) ? [Number(point[0]) || 0, Number(point[1]) || 0] : [0, 0]))
			: []
		lines.push({ text, score: typeof entry?.score === 'number' ? entry.score : 0, box })
		used += text.length + 1
	}
	let text = lines.map((line) => line.text).join('\n')
	if (text.length > maxTextChars) text = `${text.slice(0, maxTextChars)}\n[truncated]`
	return { path, text, lines, elapsedMs }
}

/**
 * Plugin entry. Registers the `ocr_image` tool.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the validated row config.
 * @returns {() => Promise<void>} the disposer run when the plugin is disabled, reloaded or removed.
 */
export function apply(ctx, config) {
	const options = {
		enabled: config.enabled !== false,
		timeoutMs: config.timeoutMs,
		maxImageBytes: config.maxImageBytes,
		maxPixels: config.maxPixels,
		maxTextChars: config.maxTextChars,
		startTimeoutMs: config.startTimeoutMs,
	}
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('rapidocr: timeoutMs must be a positive finite number')
	if (!Number.isFinite(options.maxImageBytes) || options.maxImageBytes <= 0) throw new Error('rapidocr: maxImageBytes must be a positive finite number')
	if (!Number.isFinite(options.maxPixels) || options.maxPixels < 0) throw new Error('rapidocr: maxPixels must be a non-negative finite number')
	if (!Number.isFinite(options.maxTextChars) || options.maxTextChars < 0) throw new Error('rapidocr: maxTextChars must be a non-negative finite number')
	if (!Number.isFinite(options.startTimeoutMs) || options.startTimeoutMs <= 0) throw new Error('rapidocr: startTimeoutMs must be a positive finite number')

	/** The sidecar; created lazily so an unused plugin never spawns a child. */
	let sidecar = undefined
	/** Unregisters the tool from the registry. */
	let unregisterTool = undefined
	let disposed = false

	if (options.enabled) {
		const workerPath = resolveWorkerPath()
		sidecar = new OcrSidecar(ctx, {
			workerPath,
			startTimeoutMs: options.startTimeoutMs,
			cwd: fileURLToPath(new URL('.', import.meta.url)),
			// The pixel cap is enforced inside the sidecar, where the decoded
			// dimensions are known; the host only knows the compressed size.
			env: { RAPIDOCR_MAX_PIXELS: String(options.maxPixels) },
		})

		// The tool is registered on the plugin context, so it is released when
		// the context goes away; the disposer below unregisters it explicitly.
		unregisterTool = ctx.tools.register({
			name: 'ocr_image',
			description:
				'Recognise the text inside an image file (PNG or JPEG) with a local CPU OCR engine and return the recognised text. Use it whenever an image may contain text, such as a screenshot, a scanned page or a photo of a document. The image is read on this machine and never leaves it.',
			// Raw JSON Schema: the registry projects `parameters` verbatim
			// (`dsh-tools/lib/index.js:366-376`).
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					file_path: {
						type: 'string',
						description: 'Path to the image file, resolved against the session working directory.',
					},
				},
				required: ['file_path'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						path: {
							type: 'string',
							description: 'Canonical absolute path of the recognised image in the filesystem execution world.',
						},
						text: {
							type: 'string',
							description: 'The recognised text.',
						},
						lines: {
							type: 'array',
							description: 'One entry per recognised text line.',
							items: {
								type: 'object',
								additionalProperties: false,
								properties: {
									text: { type: 'string', description: 'The recognised text of one line.' },
									score: { type: 'number', description: 'Confidence score of the line.' },
									box: {
										type: 'array',
										description: 'The four corner points of the line box, each a [x, y] pair in pixels.',
										items: { type: 'array', items: { type: 'number' } },
									},
								},
								required: ['text', 'score', 'box'],
							},
						},
						elapsedMs: {
							type: 'number',
							description: 'Milliseconds spent recognising the image.',
						},
					},
					required: ['path', 'text', 'lines', 'elapsedMs'],
				},
				// The model-facing envelope mirrors the built-in `read_image`
				// convention: `<path>…</path><type>…</type><content>…</content>`
				// (`dsh-tool-fs/lib/index.js:1724-1728`).
				render: (_args, value) => [{
					type: 'text',
					text: `<path>${value.path}</path>\n<type>text</type>\n<content>\n${value.text}\n</content>`,
				}],
				presentationMeta: (_args, value) => ({ path: value.path }),
			},
			timeoutMs: options.timeoutMs,
			// The sidecar queues requests internally, so parallel calls are safe.
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				const requested = args === null || typeof args !== 'object' ? undefined : args.file_path
				if (typeof requested !== 'string' || requested.trim().length === 0) {
					throw new Error('file_path must be a non-empty string')
				}

				// 1. Resolve the path against the calling session's working directory
				//    (`dsh-tool-fs/lib/index.js:174-180`).
				const cwd = exec.agent === undefined
					? undefined
					: await ctx.workingDirectory.ensure(exec.agent, exec.signal)
				const target = await ctx.fs.resolve(requested, {
					...(cwd !== undefined ? { cwd } : {}),
					signal: exec.signal,
				})

				// 2. Require an existing regular file (`dsh-tool-fs/lib/index.js:194-205`).
				const info = await ctx.fs.stat(target, exec.signal)
				if (info === undefined) throw new Error(`cannot read "${target.displayPath}": not found`)
				if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`)

				// 3. Read the bytes through the filesystem backend so path
				//    authorisation stays with `ctx.fs`
				//    (`dsh-tool-fs/lib/index.js:1790`).
				const data = await ctx.fs.readBytes(target, exec.signal, options.maxImageBytes)

				// 4. Detect the container from the bytes, never from the name.
				const mediaType = sniffImageMediaType(data)
				if (mediaType === undefined) {
					throw new Error(`cannot read "${target.displayPath}": the file content is not a supported image format; ocr_image accepts PNG and JPEG images`)
				}

				// 5. Recognise the text in the sidecar.
				const started = Date.now()
				const message = await recognise(sidecar, {
					id: randomUUID(),
					op: 'ocr',
					image: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
					mediaType,
				}, exec.signal)
				const elapsedMs = Date.now() - started

				// 6. Return a value matching `output.schema`.
				return toOutputValue(message, ctx.fs.processPath(target), elapsedMs, options.maxTextChars)
			},
			presentCall(args) {
				const requested = args === null || typeof args !== 'object' ? undefined : args.file_path
				return {
					card: 'generic',
					title: `Recognise text in ${requested}`,
					kind: 'read',
					locations: [{ path: typeof requested === 'string' ? requested : '' }],
				}
			},
		})

		// A short hint so a text-only model learns that it can read images
		// this way. `ctx.inject` keeps the section optional: it exists only
		// while the prompt registry is mounted.
		ctx.inject(['systemPrompt'], (promptCtx) => {
			promptCtx.systemPrompt.section({
				name: 'tool:ocr_image',
				order: OCR_SECTION_ORDER,
				text: ({ scope }) => ctx.tools.get('ocr_image', scope) === undefined
					? ''
					: 'Use ocr_image to read the text out of an image file such as a screenshot, a scanned page or a photo of a document. It accepts PNG and JPEG files and returns the recognised text; the image is processed on this machine and never leaves it.',
			})
		})
	}

	// The disposer returned from `apply` runs when the entry is disabled,
	// removed or reconfigured (`cordis-plugin-loader/README.md:63`;
	// `dsh-hmr/README.md:67,69`).
	return async () => {
		if (disposed) return
		disposed = true
		if (unregisterTool !== undefined) {
			try {
				unregisterTool()
			} catch {}
			unregisterTool = undefined
		}
		if (sidecar !== undefined) {
			await sidecar.dispose()
			sidecar = undefined
		}
	}
}
