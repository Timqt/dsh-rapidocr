// Toggle a bundle in the profile's selected-bundles list.
//
// The Plugin Manager's enable/disable path is currently blocked by a Host-side
// error ("HMR transactions cannot be nested"), so this performs the same
// manifest change the manager would, in two steps, which makes HMR recompose
// and reload the linked package's changed files.
//
//   node toggle-bundle.mjs <profileDir> <bundleName> add|remove
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const [profileDir, bundleName, action] = process.argv.slice(2)
const manifestPath = join(profileDir, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles ?? []

const next =
  action === 'remove'
    ? bundles.filter((name) => name !== bundleName)
    : bundles.includes(bundleName)
      ? bundles
      : [...bundles, bundleName]

manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
const temp = `${manifestPath}.tmp-toggle`
writeFileSync(temp, JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
renameSync(temp, manifestPath)
console.log(`${action}: bundles now ${next.length}${next.includes(bundleName) ? ' (present)' : ' (absent)'}`)
