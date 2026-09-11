/**
 * Runs the built application end to end and reports the result.
 *
 * Uses an isolated data directory so a smoke run never touches real settings,
 * memory or history, and starts a virtual display when there is no X server
 * (CI, containers).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-smoke-'))
const home = mkdtempSync(join(tmpdir(), 'jarvis-home-'))

const hasDisplay = !!process.env.DISPLAY
const hasXvfb = spawnSync('which', ['xvfb-run']).status === 0
if (!hasDisplay && !hasXvfb) {
  console.error('No display and no xvfb-run available; cannot run the smoke test here.')
  process.exit(1)
}

const electron = join(root, 'node_modules', '.bin', 'electron')
const args = [root, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
const command = hasDisplay ? electron : 'xvfb-run'
const commandArgs = hasDisplay ? args : ['-a', '--server-args=-screen 0 1600x1000x24', electron, ...args]

const child = spawn(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: home,
    JARVIS_SMOKE: '1',
    JARVIS_DATA_DIR: dataDir,
    JARVIS_SMOKE_OUT: process.env.JARVIS_SMOKE_OUT ?? join(root, 'screenshots'),
    JARVIS_VERBOSE: process.env.JARVIS_VERBOSE ?? '0',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
  }
})

child.on('exit', (code) => {
  for (const dir of [dataDir, home]) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  process.exit(code ?? 1)
})
