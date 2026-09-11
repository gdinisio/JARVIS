/**
 * Verifies the Electron binary is present, and fetches it if it is not.
 *
 * `npm install` downloads the binary from a postinstall script, which is
 * skipped when `ignore-scripts` is set and fails in several distinct ways
 * behind proxies, antivirus and synced folders. electron-vite reports all of
 * them as `Error: Electron uninstall`, which points at nothing actionable,
 * so this runs first and says what actually went wrong.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyFailure, riskyLocation } from './lib/electron-diagnosis.mjs'

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

/** Can we actually write into the place the binary has to go? */
function writable(dir) {
  const target = join(dir, 'dist')
  const probe = join(target, '.jarvis-write-probe')
  try {
    mkdirSync(target, { recursive: true })
    writeFileSync(probe, 'probe')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

function permissionAdvice(location) {
  return `
Windows refused to write the file. This is a permissions or antivirus problem,
not a download problem${location ? `, and the project living in ${location} is the usual cause` : ''}.

In order of likelihood:

  1. A stale Electron process is holding the file:
       taskkill /f /im electron.exe
       Remove-Item -Recurse -Force node_modules\\electron\\dist
       node node_modules\\electron\\install.js

  2. Move the project somewhere Windows does not protect or sync.
     Documents, Desktop and Pictures are covered by Defender's Controlled
     Folder Access, and are usually OneDrive-synced. Either will block a
     150 MB .exe being written:
       cd $env:USERPROFILE
       mkdir dev -Force
       Move-Item "${root}" dev\\JARVIS
       cd dev\\JARVIS
       npm install
       npm run dev

  3. Allow it through Controlled Folder Access:
     Windows Security -> Virus & threat protection -> Ransomware protection
     -> Allow an app through Controlled folder access, and add node.exe.

  4. If OneDrive is syncing the folder, pause syncing and retry.
`
}

function networkAdvice() {
  return `
The download itself failed. Try one of:

  - Behind a proxy:
      npm config set proxy http://your-proxy:port
      npm config set https-proxy http://your-proxy:port

  - Use a mirror:
      set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
      node node_modules/electron/install.js

  - Download it by hand from
    https://github.com/electron/electron/releases
    then set ELECTRON_OVERRIDE_DIST_PATH to the extracted folder.
`
}

const dir = moduleDir()
if (!dir) {
  console.error('\nElectron is not installed. Run `npm install` first.\n')
  process.exit(1)
}

if (binaryPath(dir)) process.exit(0)

const location = riskyLocation(root, homedir())

// Check writability before downloading: failing after 150 MB is unkind.
if (!writable(dir)) {
  console.error(permissionAdvice(location))
  process.exit(1)
}

console.log('Electron binary is missing; downloading it now (this happens once, ~100 MB)…')
const installer = join(dir, 'install.js')
if (!existsSync(installer)) {
  console.error(`\nElectron's installer is missing at ${installer}.\nRemove node_modules and run \`npm install\` again.\n`)
  process.exit(1)
}

// Clear a half-extracted dist so the installer starts from a clean state.
try {
  rmSync(join(dir, 'dist'), { recursive: true, force: true })
} catch {
  /* nothing to clear */
}

const result = spawnSync(process.execPath, [installer], {
  cwd: dir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
})

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
if (output) console.log(output)

if (result.status === 0 && binaryPath(dir)) {
  console.log('Electron is ready.\n')
  process.exit(0)
}

// Say what actually went wrong rather than guessing.
console.error("\nElectron's binary could not be installed.")
switch (classifyFailure(output)) {
  case 'permission':
    console.error(permissionAdvice(location))
    break
  case 'network':
    console.error(networkAdvice())
    break
  default:
    console.error(permissionAdvice(location))
    console.error(networkAdvice())
}
process.exit(1)
