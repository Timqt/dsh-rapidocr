// Add the installed bundle to the profile's selected-bundles list.
//
// The Plugin Manager's own enable step is currently blocked by a Host-side
// error ("HMR transactions cannot be nested"), so this performs exactly the
// manifest change that `selectBundle()` performs: append the bundle name to
// `dsh.profile.bundles`. HMR watches the manifest and recomposes when the
// ordered list changes, so the plugin mounts without a restart.
//
// The document is written with the same serialisation the manager uses:
// JSON.stringify(manifest, undefined, 2) + "\n".
import { readFileSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

const profileDir = process.argv[2]
const bundleName = process.argv[3]

const manifestPath = join(profileDir, 'package.json')
const backupPath = join(profileDir, '.plugin-manager', 'package.json.before-rapidocr-enable')
const raw = readFileSync(manifestPath, 'utf8')
const manifest = JSON.parse(raw)

const bundles = manifest.dsh?.profile?.bundles ?? []
if (bundles.includes(bundleName)) {
  console.log(`already selected: ${bundleName}`)
  process.exit(0)
}

manifest.dsh = {
  ...manifest.dsh,
  profile: {
    ...manifest.dsh?.profile,
    bundles: [...bundles, bundleName],
  },
}

copyFileSync(manifestPath, backupPath)
const temp = `${manifestPath}.tmp-rapidocr`
writeFileSync(temp, JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
renameSync(temp, manifestPath)

console.log(`selected ${bundleName}; bundles now ${manifest.dsh.profile.bundles.length} (backup: ${backupPath})`)
