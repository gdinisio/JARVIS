import { describe, it, expect } from 'vitest'
import { speakable, toSentences, humanisePath, stripMarkdown, prepareSpeech } from '../src/shared/speech'

describe('humanisePath', () => {
  it('says the file and the folder it is in', () => {
    expect(humanisePath('~/Downloads/report.pdf')).toBe('report.pdf in Downloads')
    expect(humanisePath('C:\\Users\\Giovanni\\Documents\\notes.txt')).toBe('notes.txt in Documents')
  })

  it('names a folder without inventing a parent', () => {
    expect(humanisePath('~/Projects/aurora')).toBe('aurora')
    expect(humanisePath('/usr/local/bin')).toBe('bin')
  })

  it('handles the home directory itself', () => {
    expect(humanisePath('~/')).toBe('the home folder')
  })
})

describe('speakable', () => {
  it('never reads a path out slash by slash', () => {
    const spoken = speakable('I saved it to ~/Documents/Projects/report.pdf just now.')
    expect(spoken).not.toContain('/')
    expect(spoken).toContain('report.pdf in Projects')
  })

  it('expands units into words', () => {
    expect(speakable('Using 2.1 GB of 16 GB')).toBe('Using 2.1 gigabytes of 16 gigabytes')
    expect(speakable('CPU is at 28%')).toContain('28 percent')
    expect(speakable('Finished in 340ms')).toContain('340 milliseconds')
    expect(speakable('Took 1.4s')).toContain('1.4 seconds')
    expect(speakable('Running at 62°C')).toContain('62 degrees')
  })

  it('spells acronyms that would otherwise be mumbled', () => {
    expect(speakable('CPU and GPU load')).toBe('C P U and G P U load')
  })

  it('removes markdown rather than reading its punctuation', () => {
    expect(speakable('**Done.** See `config.json` and [the docs](https://x.com).')).toBe(
      'Done. See config.json and the docs.'
    )
  })

  it('removes symbols and emoji that have no spoken form', () => {
    const spoken = speakable('Settings \u2192 Voice \u2713 ready \u{1F680}')
    expect(spoken).not.toMatch(/[\u2192\u2713\u{1F680}]/u)
    expect(spoken).toContain('Settings')
    expect(spoken).toContain('ready')
  })

  it('turns line breaks into pauses instead of running sentences together', () => {
    expect(speakable('First line\nSecond line')).toBe('First line, Second line')
    expect(speakable('One paragraph\n\nAnother paragraph')).toBe('One paragraph. Another paragraph')
  })

  it('leaves ordinary prose untouched', () => {
    const plain = 'Certainly. Opening Chrome now.'
    expect(speakable(plain)).toBe(plain)
  })

  it('says a web address as its host, not its path', () => {
    expect(speakable('see https://example.com/docs/page for details')).toBe('see example.com for details')
    expect(speakable('open https://www.github.com/gdinisio/JARVIS')).toBe('open github.com')
  })

  it('turns an arrow into a pause rather than running clauses together', () => {
    expect(speakable('Deleted 42 files \u2192 freed 3.4 GB')).toBe('Deleted 42 files, freed 3.4 gigabytes')
  })

  it('does not mangle fractions or times', () => {
    expect(speakable('about 1/2 of the disk')).toContain('1/2')
  })

  it('survives empty and whitespace input', () => {
    expect(speakable('')).toBe('')
    expect(speakable('   \n  ')).toBe('')
  })

  it('collapses doubled punctuation left behind by substitutions', () => {
    expect(speakable('Done.. really')).toBe('Done. really')
    expect(speakable('Wait ,  then go')).toBe('Wait, then go')
  })
})

describe('toSentences', () => {
  it('splits on sentence boundaries', () => {
    expect(toSentences('Certainly. Opening Chrome. It is ready.')).toEqual([
      'Certainly.',
      'Opening Chrome.',
      'It is ready.'
    ])
  })

  it('does not split inside a decimal number', () => {
    expect(toSentences('Memory is at 2.1 gigabytes right now.')).toEqual(['Memory is at 2.1 gigabytes right now.'])
  })

  it('gives an unpunctuated fragment a full stop so it does not trail upward', () => {
    expect(toSentences('Opening Chrome')).toEqual(['Opening Chrome.'])
  })

  it('breaks a very long sentence into speakable chunks', () => {
    const long = `${'word '.repeat(90)}end.`
    const chunks = toSentences(long, 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(240)
  })

  it('returns nothing for input with no spoken content', () => {
    expect(toSentences('')).toEqual([])
    expect(toSentences('...')).toEqual([])
  })
})

describe('prepareSpeech', () => {
  it('delivers one utterance when chunking is switched off', () => {
    const result = prepareSpeech('Certainly. Opening Chrome. It is ready.', { chunked: false })
    expect(result.sentences).toHaveLength(1)
    expect(result.sentences[0]).toBe('Certainly. Opening Chrome. It is ready.')
  })

  it('splits into sentences by default', () => {
    expect(prepareSpeech('Certainly. Opening Chrome. It is ready.').sentences).toHaveLength(3)
  })

  it('returns nothing speakable for empty input', () => {
    expect(prepareSpeech('   ')).toEqual({ text: '', sentences: [] })
  })

  it('produces both the cleaned text and its sentences', () => {
    const result = prepareSpeech('**CPU** is at 28%.\nMemory is at 2.1 GB.')
    expect(result.text).toBe('C P U is at 28 percent. Memory is at 2.1 gigabytes.')
    expect(result.sentences.length).toBeGreaterThanOrEqual(1)
  })

  it('is safe on a real assistant reply', () => {
    const reply = 'Done. I moved 3 files to ~/Documents/Archive — that freed 1.2 GB.'
    const { text } = prepareSpeech(reply)
    expect(text).not.toContain('/')
    expect(text).not.toContain('—')
    expect(text).toContain('1.2 gigabytes')
  })
})
