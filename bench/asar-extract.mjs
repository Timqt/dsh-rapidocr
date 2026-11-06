// Extract files from app.asar to a local directory. rg and the glob tool
// cannot traverse the archive, so the archive index is parsed directly.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const asarPath = process.argv[2]
const outDir = process.argv[3]
const filters = process.argv.slice(4)

const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))

function walk(node, prefix = '') {
  const out = []
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (entry.files) out.push(...walk(entry, rel))
    else out.push({ path: rel, offset: Number(entry.offset ?? 0), size: Number(entry.size ?? 0) })
  }
  return out
}

const base = 16 + headerSize
let n = 0
for (const file of walk(header)) {
  if (filters.length > 0 && !filters.some((f) => file.path.includes(f))) continue
  const dest = join(outDir, file.path)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, buf.slice(base + file.offset, base + file.offset + file.size))
  n += 1
}
console.log(`extracted ${n} file(s) to ${outDir}`)
