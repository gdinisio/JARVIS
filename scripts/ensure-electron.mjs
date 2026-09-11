/**
 * Verifies the Electron binary is present, and fetches it if it is not.
 *
 * `npm install` downloads the binary from a postinstall script, which is
 * skipped entirely when `ignore-scripts` is set and fails silently behind
 * some proxies and corporate firewalls. electron-vite then reports the
 * missing binary as `Error: Electron uninstall`, which says nothing useful.
 * This runs before every dev, build and smoke command and repairs it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function moduleDir() {
  try {
    return dirname(require.resolve('electron/package.json', { paths: [root] }))
  } catch {
    return null
  }
}

/** Returns the binary path when it exists on disk, otherwise null. */
function binaryPath(dir) {
  const pathFile = join(dir, 'path.txt')
  if (!existsSync(pathFile)) return null
  const relative = readFileSync(pathFile, 'utf8').trim()
  if (!relative) return null
  const binary = join(dir, 'dist', relative)
  return existsSync(binary) ? binary : null
}

const dir = moduleDir()
if (!dir) {
  console.error('\nElectron is not installed. Run `npm install` first.\n')
  process.exit(1)
}

if (binaryPath(dir)) process.exit(0)

console.log('Electron binary is missing; downloading it now (this happens once, ~100 MB)…')
const installer = join(dir, 'install.js')
if (!existsSync(installer)) {
  console.error(`\nElectron's installer is missing at ${installer}.\nRemove node_modules and run \`npm install\` again.\n`)
  process.exit(1)
}

const result = spawnSync(process.execPath, [installer], { cwd: dir, stdio: 'inherit' })

if (result.status === 0 && binaryPath(dir)) {
  console.log('Electron is ready.\n')
  process.exit(0)
}

console.error(`
Electron's binary could not be downloaded.

This is almost always the network, not the project. Try one of:

  • Behind a proxy:
      npm config set proxy http://your-proxy:port
      npm config set https-proxy http://your-proxy:port

  • Use a mirror (e.g. in mainland China):
      set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
      node node_modules/electron/install.js

  • Download it by hand:
      Get the release for your platform from
      https://github.com/electron/electron/releases
      then set ELECTRON_OVERRIDE_DIST_PATH to the extracted folder.

Once the download succeeds, \`npm run dev\` will work.
`)
process.exit(1)
