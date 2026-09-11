export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '').trim()
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const value = Number.parseInt(full.slice(0, 6), 16)
  if (!Number.isFinite(value)) return { r: 224, g: 31, b: 61 }
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function rgba({ r, g, b }: Rgb, alpha: number): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/** Mixes towards white, for the hot centre of the core. */
export function lighten(colour: Rgb, amount: number): Rgb {
  return {
    r: Math.round(colour.r + (255 - colour.r) * amount),
    g: Math.round(colour.g + (255 - colour.g) * amount),
    b: Math.round(colour.b + (255 - colour.b) * amount)
  }
}
