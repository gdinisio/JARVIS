import { randomUUID } from 'node:crypto'

export function id(prefix = ''): string {
  const uuid = randomUUID().replace(/-/g, '').slice(0, 12)
  return prefix ? `${prefix}_${uuid}` : uuid
}

export function now(): number {
  return Date.now()
}
