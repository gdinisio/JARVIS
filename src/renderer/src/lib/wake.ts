/**
 * Matches the wake phrase at the start of an utterance.
 *
 * Returns the remainder of the utterance (possibly empty) when the phrase is
 * present, or `null` when it is not. Sensitivity controls how much slop is
 * allowed in the match — transcripts of "hey JARVIS" vary a lot.
 */
export function matchWakePhrase(text: string, phrase: string, sensitivity: number): string | null {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const spoken = normalise(text)
  const wake = normalise(phrase)
  if (!spoken || !wake) return null

  const index = spoken.indexOf(wake)
  if (index === 0) return spoken.slice(wake.length).trim()
  if (index > 0 && index <= 12) return spoken.slice(index + wake.length).trim()

  // Fall back to the distinctive last word ("jarvis") when the transcript
  // mangles the greeting, but only at higher sensitivity.
  const keyword = wake.split(' ').slice(-1)[0]
  if (sensitivity >= 0.5 && keyword.length >= 4) {
    const soundalikes = [keyword, 'jarvis', 'jarvus', 'jervis', 'javis', 'jarvis ']
    for (const candidate of soundalikes) {
      const at = spoken.indexOf(candidate)
      if (at >= 0 && at <= 14) return spoken.slice(at + candidate.length).trim()
    }
  }
  return null
}
