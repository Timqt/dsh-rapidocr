// Independent end-to-end check of the plugin's Host half.
//
// It builds a stand-in DSH context (tools registry, working directory, fs
// backend and subprocess provider) and drives the real plugin module: apply,
// tool registration, one OCR call through the real sidecar, a second call that
// must reuse the warm engine, and the disposer.
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = resolve(process.argv[2] ?? 'packages/dsh-rapidocr/index.js')
const IMAGE = resolve(process.argv[3] ?? 'bench/samples/screenshot_1280x720.png')

let spawnCount = 0

/** A minimal stand-in for the Host's `subprocess` service. */
const subprocess = {
  spawn(spec) {
    spawnCount += 1
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

/** A minimal stand-in for the Host's `fs` service. */
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
const tools = {
  register(definition) {
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  },
  get(name) { return registered.get(name) },
}

const ctx = {
  tools,
  fs: fsService,
  workingDirectory: { async ensure() { return process.cwd() } },
  subprocess,
  effect(fn) { return fn() },
  inject(_names, cb) { cb(ctx) },
  systemPrompt: { section() {} },
}

const module = await import(pathToFileURL(PLUGIN).href)
console.log('exports          :', Object.keys(module).sort().join(', '))
console.log('inject           :', JSON.stringify(module.inject))

/** Resolve the row config the way the loader does: through Standard Schema. */
function resolveConfig(raw) {
  const standard = module.Config['~standard']
  if (standard === undefined) return module.Config.parse(raw)
  const result = standard.validate(raw)
  if (result instanceof Promise) throw new Error('async config validation is not supported')
  if (result.issues) throw new Error(`config invalid: ${JSON.stringify(result.issues)}`)
  return result.value
}

const config = resolveConfig({})
console.log('config defaults  :', JSON.stringify(config))

const dispose = module.apply(ctx, config)
console.log('registered tools :', [...registered.keys()].join(', '))

const tool = registered.get('ocr_image')
if (!tool) throw new Error('ocr_image was not registered')

const first = await tool.execute({ file_path: IMAGE }, { agent: undefined, signal: new AbortController().signal })
console.log('\n--- call 1 ---')
console.log('spawns           :', spawnCount)
console.log('elapsedMs        :', first.elapsedMs)
console.log('lines            :', first.lines.length)
console.log('text             :\n' + first.text)

const second = await tool.execute({ file_path: IMAGE }, { agent: undefined, signal: new AbortController().signal })
console.log('\n--- call 2 (warm) ---')
console.log('spawns           :', spawnCount, '(must stay 1)')
console.log('elapsedMs        :', second.elapsedMs)
console.log('identical text   :', first.text === second.text)

console.log('\n--- renderer output (model-facing) ---')
console.log(JSON.stringify(tool.output.render({ file_path: IMAGE }, first), null, 2).slice(0, 400))

await dispose()
console.log('\nafter dispose    : registered tools =', registered.keys().next().value ?? '(none)')
