/**
 * Turning written text into something worth listening to.
 *
 * Speech engines read what they are given literally: a file path becomes
 * "slash home slash user slash documents", "2.1 GB" becomes "two point one
 * gee bee", and a paragraph with no punctuation is delivered in one flat
 * breath. Most of what makes synthesised speech sound robotic is the input,
 * not the voice — so this cleans the text and breaks it into clauses the
 * engine can shape prosody around.
 *
 * Pure, shared by every speech engine, and unit-tested.
 */

/** Units expanded so they are spoken rather than spelled. */
const UNITS: Array<[RegExp, string]> = [
  [/(\d+(?:\.\d+)?)\s?TB\b/g, '$1 terabytes'],
  [/(\d+(?:\.\d+)?)\s?GB\b/g, '$1 gigabytes'],
  [/(\d+(?:\.\d+)?)\s?MB\b/g, '$1 megabytes'],
  [/(\d+(?:\.\d+)?)\s?KB\b/g, '$1 kilobytes'],
  [/(\d+(?:\.\d+)?)\s?ms\b/g, '$1 milliseconds'],
  [/(\d+(?:\.\d+)?)\s?GHz\b/g, '$1 gigahertz'],
  [/(\d+(?:\.\d+)?)\s?°C\b/g, '$1 degrees'],
  [/(\d+(?:\.\d+)?)\s?%/g, '$1 percent'],
  [/\b(\d+(?:\.\d+)?)s\b/g, '$1 seconds']
]

/** Symbols that have no spoken form and should not be read aloud. */
const SYMBOLS: Array<[RegExp, string]> = [
  [/\s*[→←↔⇒]\s*/g, ', '],     // arrows separate clauses
  [/…/g, ', '],                              // ellipsis
  [/[‘’]/g, "'"],
  [/[“”]/g, ''],
  [/[–—]/g, ', '],                      // en/em dash becomes a pause
  [/·|•/g, ', '],                       // middle dot, bullet
  [/[✓✗✕⚠️]/g, ' '],     // ticks, crosses, warning
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' '] // emoji and dingbats
]

/** Written forms that are read badly when spoken. */
const PHRASES: Array<[RegExp, string]> = [
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
  [/\betc\./gi, 'and so on'],
  [/\bvs\.?\b/gi, 'versus'],
  [/\bapprox\.?\b/gi, 'approximately'],
  [/\b&\b/g, 'and'],
  [/\bw\//g, 'with'],
  [/\bN\/A\b/g, 'not available'],
  [/(?<![.\w])CPU\b/g, 'C P U'],
  [/(?<![.\w])GPU\b/g, 'G P U'],
  [/(?<![.\w])OS\b/g, 'O S'],
  [/(?<![.\w])URL\b/g, 'U R L'],
  [/(?<![.\w])PDF\b/gi, 'P D F'],
  [/(?<![.\w])ID\b/g, 'I D']
]

/**
 * Matches a filesystem path without eating the sentence around it.
 *
 * A path starts at a token boundary (so "1/2" and "and/or" are left alone),
 * and its final segment may not contain spaces — otherwise
 * "~/Docs/report.pdf just now" would swallow "just now" as part of the name.
 * Middle segments may contain spaces, because "C:\Program Files\..." is real.
 */
const PATH_PATTERN =
  /(?<![\w:/\\])(?:~|\.{1,2}|[A-Za-z]:)?(?:[\\/][\w.()@+-]+(?: [\w.()@+-]+)*(?=[\\/]))*[\\/][\w.()@+-]+\/?/g

/** Nobody says "slash docs slash page"; the host is the useful part. */
const URL_PATTERN = /\bhttps?:\/\/(?:www\.)?([^\s/]+)(?:\/\S*)?/gi

/**
 * Replaces a filesystem path with the part a person would actually say:
 * the file name, and the folder it sits in.
 */
export function humanisePath(path: string): string {
  const segments = path.split(/[\\/]+/).filter((part) => part && part !== '~' && part !== '.' && part !== '..')
  if (!segments.length) return 'the home folder'

  const last = segments[segments.length - 1]
  const parent = segments.length > 1 ? segments[segments.length - 2] : null
  const looksLikeFile = /\.[A-Za-z0-9]{1,6}$/.test(last)

  if (!looksLikeFile) return last
  return parent ? `${last} in ${parent}` : last
}

/** Strips markdown so its punctuation is not read out. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^>\s?/gm, '')
}

/**
 * Prepares text for a speech engine.
 *
 * The result is plain prose with spoken units, no markup, no paths and no
 * symbols the engine would spell out letter by letter.
 */
export function speakable(input: string): string {
  if (!input) return ''
  let text = stripMarkdown(input)

  // URLs before paths, or the path rule chews through the middle of one.
  text = text.replace(URL_PATTERN, (_match, host: string) => ` ${host} `)

  // Paths next: they contain dots and slashes the later rules would mangle.
  text = text.replace(PATH_PATTERN, (match) => {
    const value = match.trim()
    const segments = value.split(/[\\/]+/).filter(Boolean)
    const anchored = /^(~|\.{1,2}|[A-Za-z]:)/.test(value)
    // One bare segment is a word, not a path: "/home" stays, "and/or" does not.
    if (!anchored && segments.length < 2) return match
    return ` ${humanisePath(value)} `
  })
  text = text.replace(/(^|\s)~(\s|$)/g, '$1the home folder$2')

  for (const [pattern, replacement] of SYMBOLS) text = text.replace(pattern, replacement)
  for (const [pattern, replacement] of UNITS) text = text.replace(pattern, replacement)
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement)

  return text
    .replace(/\s*\n\s*\n\s*/g, '. ')             // paragraph break ends a sentence
    .replace(/([.!?])\s*\n\s*/g, '$1 ')            // already punctuated: no extra pause
    .replace(/\s*\n\s*/g, ', ')                    // otherwise a line break is a pause
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([.!?])[,;:]+/g, '$1')                // ".," left by substitutions
    .replace(/([,;:.])\1+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.]+/, '')                      // never open on punctuation
    .replace(/[\s,;:]+$/, '')
    .trim()
}

/** Abbreviations that end in a full stop but do not end a sentence. */
const NON_TERMINAL = /\b(mr|mrs|ms|dr|prof|st|approx|no|vs|fig|inc|ltd|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.$/i

/**
 * Splits prose into sentences for chunked delivery.
 *
 * Speaking one long utterance gives the engine a single flat contour. Feeding
 * it a sentence at a time lets it shape each one, which is most of the
 * difference between "read by a machine" and "spoken".
 */
export function toSentences(input: string, maxLength = 220): string[] {
  const text = input.trim()
  if (!text) return []

  // Split on sentence boundaries, rejoining anything an abbreviation broke.
  const sentences: string[] = []
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    const previous = sentences[sentences.length - 1]
    if (previous && NON_TERMINAL.test(previous)) sentences[sentences.length - 1] = `${previous} ${piece}`
    else sentences.push(piece)
  }

  // A sentence longer than a breath is split again, at clause boundaries first
  // and on words only as a last resort.
  const chunks: string[] = []
  for (const sentence of sentences) {
    if (sentence.length <= maxLength) {
      chunks.push(sentence)
      continue
    }
    let buffer = ''
    for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
      if (!buffer) buffer = clause
      else if (`${buffer} ${clause}`.length <= maxLength) buffer = `${buffer} ${clause}`
      else {
        chunks.push(buffer)
        buffer = clause
      }
    }
    if (buffer) chunks.push(buffer)
  }

  const sized: string[] = []
  for (const chunk of chunks) {
    if (chunk.length <= maxLength) {
      sized.push(chunk)
      continue
    }
    let buffer = ''
    for (const word of chunk.split(/\s+/)) {
      if (!buffer) buffer = word
      else if (`${buffer} ${word}`.length <= maxLength) buffer = `${buffer} ${word}`
      else {
        sized.push(buffer)
        buffer = word
      }
    }
    if (buffer) sized.push(buffer)
  }

  // A fragment with no final punctuation is delivered with a rising,
  // unfinished contour, which is a large part of why TTS sounds off.
  return sized
    .map((part) => part.trim())
    .filter((part) => part.replace(/[^A-Za-z0-9]/g, '').length > 0)
    .map((part) => (/[.!?,;:]$/.test(part) ? part : `${part}.`))
}

/**
 * Everything a speech engine needs for one reply.
 *
 * With `chunked` off the reply is delivered as a single utterance; otherwise
 * it is split into sentences so the engine can shape each one.
 */
export function prepareSpeech(
  input: string,
  options: { chunked?: boolean; maxLength?: number } = {}
): { text: string; sentences: string[] } {
  const text = speakable(input)
  if (!text) return { text: '', sentences: [] }
  if (options.chunked === false) return { text, sentences: [text] }
  return { text, sentences: toSentences(text, options.maxLength ?? 220) }
}
