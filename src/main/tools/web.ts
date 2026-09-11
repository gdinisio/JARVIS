import { platform } from '../platform'
import { validateUrl } from './validate'
import { ok, fail, blocked, type ToolHandler } from './context'
import { memory } from '../core/memory'

export const openUrl: ToolHandler = async (args) => {
  const check = validateUrl(args.url)
  if (!check.ok) return blocked(check.reason)
  const browser = pickBrowser(args.browser)
  try {
    await platform().openUrl(check.url, browser)
    return ok(`Opening ${hostOf(check.url)}.`, { url: check.url, browser: browser ?? 'default' })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'That link could not be opened.')
  }
}

export const webSearch: ToolHandler = async (args) => {
  const query = String(args.query ?? '').trim()
  if (!query) return fail('There was nothing to search for.')
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
  const browser = pickBrowser(args.browser)
  try {
    await platform().openUrl(url, browser)
    // Be explicit: JARVIS opened the results, it has not read them.
    return ok(`Search results for "${query}" are open in your browser.`, {
      query,
      url,
      note: 'The results page is open in the browser. JARVIS has not read the results; ask it to look at the screen if you want them summarised.'
    })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The search could not be opened.')
  }
}

function pickBrowser(requested: unknown): string | undefined {
  if (typeof requested === 'string' && requested.trim()) return requested.trim()
  const preferred = memory.preferences().browser
  return preferred?.trim() || undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
