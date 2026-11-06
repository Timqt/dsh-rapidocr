// Verifies that the plugin's maxPixels config reaches the sidecar and rejects
// an oversized image before it is decoded.
//
// Reuses the stand-in Host from host-harness.mjs by applying the plugin with a
// small maxPixels override and asserting the failure message.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = resolve(process.argv[2] ?? 'packages/dsh-rapidocr/index.js')
const IMAGE = resolve(process.argv[3] ?? 'bench/samples/screenshot_1280x720.png')
const MAX_PIXELS = Number(process.argv[4] ?? 100000)

const subprocess = {
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => { stderr += c.toString() })
    const done = new Promise((resolvePromise) => {
      child.on('exit', (code, signal) => resolvePromise({ exitCode: code, signal }))
    })
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: undefined,
      collected: { stderr: { readFrom: () => ({ text: stderr }) } },
      done,
      terminate() { child.kill() },
      async waitForExit() { await done; return true },
    }
  },
}

const fsService = {
  async resolve(path, opts = {}) {
    const cwd = opts.cwd ?? process.cwd()
    return { targetKey: path, displayPath: resolve(cwd, path) }
  },
  async stat(target) {
    const p = target.displayPath
    if (!existsSync(p)) return undefined
    const s = statSync(p)
    return { type: s.isDirectory() ? 'directory' : 'file', size: s.size, version: String(s.mtimeMs) }
  },
  async readBytes(target, _signal, maxBytes) {
    const data = await readFile(target.displayPath)
    if (data.byteLength > maxBytes) throw new Error('file too large')
    return new Uint8Array(data)
  },
  processPath(target) { return target.displayPath },
}

const registered = new Map()
const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
    get(name) { return registered.get(name) },
  },
  fs: fsService,
  workingDirectory: { async ensure() { return process.cwd() } },
  subprocess,
  effect(fn) { return fn() },
  inject(_names, cb) { cb(ctx) },
  systemPrompt: { section() {} },
}

const module = await import(pathToFileURL(PLUGIN).href)
const standard = module.Config['~standard']
const config = standard === undefined
  ? module.Config.parse({ maxPixels: MAX_PIXELS })
  : standard.validate({ maxPixels: MAX_PIXELS }).value

console.log('maxPixels config :', config.maxPixels)

const dispose = module.apply(ctx, config)
const tool = registered.get('ocr_image')
if (!tool) throw new Error('ocr_image was not registered')

let message = '(no error)'
try {
  await tool.execute({ file_path: IMAGE }, { agent: undefined, signal: new AbortController().signal })
} catch (error) {
  message = error.message
}
console.log('execute result   :', message)
await dispose()

const rejected = /too large/.test(message)
console.log(rejected ? 'OK: oversized image was rejected before decoding' : 'FAIL: cap was not applied')
process.exit(rejected ? 0 : 1)
