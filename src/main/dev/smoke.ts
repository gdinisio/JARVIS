import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { logger } from '../services/logging'
import { settings } from '../services/settings'
import { executeTool } from '../tools/registry'
import { history } from '../services/history'
import { memory } from '../core/memory'
import { routines } from '../core/routines'

/**
 * End-to-end smoke run (`npm run smoke`).
 *
 * Boots the real application, drives the real UI, exercises the real tool
 * layer and captures screenshots of every screen. Only runs when
 * `JARVIS_SMOKE=1` is set.
 */

interface Step {
  name: string
  ok: boolean
  detail?: string
}

const steps: Step[] = []

/** Tab order in the title bar; the smoke run clicks by position. */
const NAV_ORDER = ['command', 'workshop', 'routines', 'memory', 'history', 'settings'] as const

function record(name: string, ok: boolean, detail?: string): void {
  steps.push({ name, ok, ...(detail ? { detail } : {}) })
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

export async function runSmoke(window: BrowserWindow): Promise<void> {
  const outDir = process.env.JARVIS_SMOKE_OUT ?? join(process.cwd(), 'screenshots')
  await mkdir(outDir, { recursive: true })

  const shoot = async (name: string) => {
    try {
      const image = await window.webContents.capturePage()
      await writeFile(join(outDir, `${name}.png`), image.toPNG())
      return true
    } catch (error) {
      logger.warn('smoke', 'Capture failed.', { name, error: String(error) })
      return false
    }
  }

  const evaluate = <T>(script: string): Promise<T> => window.webContents.executeJavaScript(script, true) as Promise<T>

  try {
    window.show()
    await wait(1400)
    record('boot sequence renders', await shoot('01-boot'))

    await wait(3200)
    record('main interface renders', await shoot('02-interface'))

    /* Onboarding is dismissed the way a user would. */
    const onboarding = await evaluate<boolean>(`!!document.querySelector('.onboarding')`)
    if (onboarding) {
      record('first-run onboarding shown', await shoot('03-onboarding'))
      await evaluate(`window.jarvis.updateSettings({ general: { onboarded: true } })`)
      await wait(600)
    }

    // Headless test machines have no speech voices; silence the engine so the
    // run exercises the interface rather than the absence of audio hardware.
    if (process.env.JARVIS_SMOKE_SILENT !== '0') {
      await evaluate(`window.jarvis.updateSettings({ voice: { engine: 'off' } })`)
      await wait(300)
    }

    /* The tool layer, through the same path the model uses. */
    const context = {
      settings: settings.get(),
      pathPolicy: {
        protectedPaths: settings.get().automation.protectedPaths,
        workspaceRoots: settings.get().automation.workspaceRoots,
        platform: process.platform
      }
    }

    const stats = await executeTool('get_system_stats', {}, context)
    record('get_system_stats returns live metrics', stats.ok, stats.summary)

    const apps = await executeTool('list_applications', {}, context)
    record('list_applications reads installed software', apps.ok, apps.summary)

    const folder = await executeTool('create_folder', { path: '~/jarvis-smoke/archive' }, context)
    record('create_folder creates a directory', folder.ok, folder.summary)

    const file = await executeTool(
      'create_file',
      { path: '~/jarvis-smoke/archive/notes.txt', content: 'JARVIS smoke test' },
      context
    )
    record('create_file writes a file', file.ok, file.summary)

    const search = await executeTool('search_files', { folder: '~/jarvis-smoke', extensions: ['txt'] }, context)
    record('search_files finds it again', search.ok && (search.data as { count: number })?.count > 0, search.summary)

    const read = await executeTool('read_text_file', { path: '~/jarvis-smoke/archive/notes.txt' }, context)
    record('read_text_file reads it back', read.ok, read.summary)

    const large = await executeTool('find_large_files', { folder: '~/jarvis-smoke', minimum_mb: 0, limit: 5 }, context)
    record('find_large_files reports what is using space', large.ok, large.summary)

    const folderSize = await executeTool('get_folder_size', { path: '~/jarvis-smoke' }, context)
    record('get_folder_size measures a folder', folderSize.ok, folderSize.summary)

    const batch = await executeTool(
      'move_files',
      { sources: ['~/jarvis-smoke/archive/notes.txt'], destination: '~/jarvis-smoke/batch' },
      context
    )
    record('move_files moves a batch in one call', batch.ok, batch.summary)

    /* Speech text preparation: the input, not the voice, is most of the polish. */
    const { speakable, toSentences } = await import('@shared/speech')
    const spokenPath = speakable('Moved 3 files to ~/Documents/Archive and freed 1.2 GB.')
    record(
      'speech text drops paths and expands units',
      !spokenPath.includes('/') && spokenPath.includes('gigabytes'),
      spokenPath
    )
    record(
      'speech text splits into sentences for delivery',
      toSentences('Certainly. Opening Chrome. It is ready.').length === 3
    )

    /* Security layer: these must be refused. */
    const traversal = await executeTool('create_folder', { path: '../../../../etc/jarvis-owned' }, context)
    record('path traversal is blocked', !traversal.ok && traversal.blocked === true, traversal.error)

    const shell = await executeTool('execute_command', { command: 'bash', args: ['-c', 'echo pwned'] }, context)
    record('shell interpreter is blocked', !shell.ok && shell.blocked === true, shell.error)

    const badUrl = await executeTool('open_url', { url: 'javascript:alert(1)' }, context)
    record('non-web URL scheme is blocked', !badUrl.ok && badUrl.blocked === true, badUrl.error)

    const { decide } = await import('../core/permissions')
    const clipboardVerdict = decide('read_clipboard', {}, settings.get())
    record('clipboard is gated until permitted', clipboardVerdict.action === 'deny', clipboardVerdict.reason)

    const batchEscape = await executeTool(
      'move_files',
      { sources: ['~/jarvis-smoke/batch/notes.txt', '/etc/passwd'], destination: '~/jarvis-smoke/escape' },
      context
    )
    record('a batch move with one bad path moves nothing', !batchEscape.ok && batchEscape.blocked === true, batchEscape.error)

    const allowed = await executeTool('execute_command', { command: 'echo', args: ['jarvis'] }, context)
    record('approved command runs', allowed.ok, allowed.summary)

    /* Memory and routines. */
    memory.remember('preferred browser', 'Firefox', 'user')
    record('memory stores a preference', memory.preferences().browser === 'Firefox', memory.preferences().browser)

    routines.save({
      name: 'Smoke Routine',
      actions: [{ tool: 'get_system_stats', args: {} }],
      triggers: ['smoke test']
    })
    record('routine saves', routines.list().some((r) => r.name === 'Smoke Routine'))

    /* The full request path: submit → engine → intent → security → tool. */
    await evaluate(`window.jarvis.submit('what is my cpu usage', 'text')`)
    await wait(3000)
    record('natural-language request executes', history.list(5).some((entry) => entry.actions.length > 0), history.list(1)[0]?.command)
    await shoot('04-command-executed')

    /* A medium-risk action must raise the confirmation gate. */
    await evaluate(`window.jarvis.submit('create a folder called JarvisConfirmTest', 'text')`)
    await wait(2600)
    const dialogVisible = await evaluate<boolean>(`!!document.querySelector('.confirm')`)
    record('confirmation gate appears for a medium-risk action', dialogVisible)
    if (dialogVisible) {
      await shoot('05-confirmation')
      // Approve it, then verify the folder really exists on disk.
      await evaluate(`document.querySelectorAll('.confirm-actions .btn')[1].click()`)
      await wait(1400)
      const created = await executeTool('get_file_info', { path: '~/JarvisConfirmTest' }, context)
      record('approved action actually runs', created.ok, created.summary)
    }

    /* Every screen. */
    for (const [index, view] of [
      ['06-routines', 'routines'],
      ['07-memory', 'memory'],
      ['08-history', 'history'],
      ['09-settings', 'settings']
    ] as const) {
      await evaluate(`document.querySelectorAll('.nav-tab')[${NAV_ORDER.indexOf(view)}].click()`)
      await wait(700)
      record(`${view} screen renders`, await shoot(index))
    }

    /* The 3D workshop: build a solid, then read a real CAD file. */
    const built = await executeTool(
      'create_3d_model',
      {
        name: 'Smoke Plate',
        units: 'mm',
        shapes: [
          { shape: 'box', size: [40, 20, 10] },
          { shape: 'cylinder', radius: 2, height: 20, at: [15, 0, 0], op: 'subtract' }
        ]
      },
      context
    )
    const builtData = built.data as { size_mm?: number[]; volume_mm3?: number } | undefined
    record('create_3d_model builds a solid to exact dimensions', built.ok && builtData?.size_mm?.[0] === 40, built.summary)
    record(
      'the subtracted hole removes the right amount of material',
      Math.abs((builtData?.volume_mm3 ?? 0) - 7874.3) < 80,
      `${builtData?.volume_mm3 ?? 0} mm³`
    )

    await evaluate(`document.querySelectorAll('.nav-tab')[${NAV_ORDER.indexOf('workshop')}].click()`)
    await wait(1800)
    const viewportLive = await evaluate<boolean>(
      `(() => { const c = document.querySelector('.viewport-canvas canvas'); return !!c && c.width > 100 })()`
    )
    record('the viewport renders the generated model', viewportLive)
    record('workshop screen renders', await shoot('14-workshop-generated'))

    const measured = await evaluate<string>(
      `document.querySelector('.workshop-measure .measure-value')?.textContent ?? ''`
    )
    record('measurements are shown alongside the model', measured.includes('40'), measured)

    const fixture = join(process.cwd(), 'tests', 'fixtures', 'plate.step')
    const cad = await executeTool('open_3d_model', { path: fixture }, context)
    record('open_3d_model reads a STEP file through OpenCascade', cad.ok, cad.summary)
    await wait(2200)
    record('CAD geometry renders in the viewport', await evaluate<boolean>(
      `(() => { const c = document.querySelector('.viewport-canvas canvas'); return !!c && c.width > 100 })()`
    ))
    record('workshop shows the CAD file', await shoot('15-workshop-cad'))

    const exported = await executeTool('export_3d_model', { path: '~/jarvis-smoke/plate.stl' }, context)
    record('export_3d_model writes an STL', exported.ok, exported.summary)

    const badModel = await executeTool('open_3d_model', { path: '/etc/passwd' }, context)
    record('a model path outside the allowed roots is refused', !badModel.ok, badModel.error)

    await evaluate(`document.querySelectorAll('.nav-tab')[0].click()`)
    await wait(500)

    /* Settings sections that matter most. */
    await evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent === 'AI')?.click()`)
    await wait(500)
    record('settings → AI renders', await shoot('10-settings-ai'))

    await evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent === 'Permissions')?.click()`)
    await wait(500)
    record('settings → Permissions renders', await shoot('11-settings-permissions'))

    await evaluate(`window.jarvis.updateSettings({ voice: { engine: 'neural' } })`)
    await evaluate(`[...document.querySelectorAll('.settings-nav-item')].find((b) => b.textContent === 'Voice')?.click()`)
    await wait(600)
    record('settings → Voice renders the neural engine', await shoot('13-settings-voice'))
    await evaluate(`window.jarvis.updateSettings({ voice: { engine: 'off' } })`)

    await evaluate(`document.querySelectorAll('.nav-tab')[0].click()`)
    await wait(500)

    /* Demo mode must be visibly labelled. */
    await evaluate(`window.jarvis.updateSettings({ general: { demoMode: true } })`)
    await evaluate(`window.jarvis.submit('open my browser', 'text')`)
    await wait(3200)
    const demoLabelled = await evaluate<boolean>(`!!document.querySelector('.demo-chip')`)
    record('demo mode is labelled in the interface', demoLabelled)
    await shoot('12-demo-mode')

    /* The provider catalogue must stay coherent. */
    const { PROVIDERS } = await import('@shared/providers')
    const { providers } = await import('../core/ai')
    record(
      'every catalogued provider has an endpoint and a default model',
      PROVIDERS.filter((entry) => entry.id !== 'custom').every(
        (entry) => /^https?:\/\//.test(entry.baseUrl) && !!entry.defaultModel
      ),
      PROVIDERS.map((entry) => entry.id).join(', ')
    )
    record(
      'a local backend is not assumed to be running',
      providers.get('ollama').isConfigured() === false,
      'ollama reports unconfigured until it answers a probe'
    )
    record('no provider is configured in this environment', !providers.anyConfigured())

    const failures = steps.filter((step) => !step.ok)
    // eslint-disable-next-line no-console
    console.log(`\nSMOKE SUMMARY: ${steps.length - failures.length}/${steps.length} passed`)
    if (failures.length) {
      // eslint-disable-next-line no-console
      console.log(`FAILED: ${failures.map((step) => step.name).join(', ')}`)
    }
    // eslint-disable-next-line no-console
    console.log(`Screenshots: ${outDir}`)

    const { app } = await import('electron')
    const { markQuitting } = await import('../windows/mainWindow')
    markQuitting()
    setTimeout(() => app.exit(failures.length ? 1 : 0), 400)
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('SMOKE RUN CRASHED:', error)
    const { app } = await import('electron')
    app.exit(2)
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
