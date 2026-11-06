// Search inside app.asar for a literal string. rg cannot traverse the asar
// archive, so the archive index is parsed directly and matching files are
// reported with their path and the surrounding line.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const asarPath = process.argv[2]
const needle = process.argv[3]
const maxFileBytes = Number(process.argv[4] ?? 8 * 1024 * 1024)
const pathFilter = process.argv[5] ?? ''

const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.slice(16, 16 + headerSize).toString('utf8'))

/** Collect every file path in the archive index. */
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
const files = walk(header)
console.log(`[asar] ${files.length} files, searching for ${JSON.stringify(needle)}`)

let hits = 0
for (const file of files) {
  if (file.size > maxFileBytes) continue
  if (pathFilter !== '' && !file.path.includes(pathFilter)) continue
  if (!/\.(js|mjs|cjs|ts|json|md|yml)$/.test(file.path)) continue
  let text
  try {
    text = buf.slice(base + file.offset, base + file.offset + file.size).toString('utf8')
  } catch {
    continue
  }
  if (!text.includes(needle)) continue
  hits += 1
  console.log(`\n=== ${file.path} ===`)
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (line.includes(needle)) {
      const from = Math.max(0, i - 12)
      const to = Math.min(lines.length, i + 13)
      console.log(`--- around line ${i + 1} ---`)
      for (let j = from; j < to; j++) console.log(`${String(j + 1).padStart(5)}| ${lines[j]}`)
    }
  })
}
console.log(`\n[asar] ${hits} file(s) matched`)
