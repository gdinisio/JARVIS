import type { SystemStats } from '@shared/types'
import { monitoring } from '../services/monitoring'
import { platform } from '../platform'
import { ok, fail, type ToolHandler } from './context'
import { formatBytes } from './filesystem'

export const getSystemStats: ToolHandler = async (args) => {
  const stats = await monitoring.snapshot()
  const include = Array.isArray(args.include) && args.include.length ? (args.include as string[]) : null
  const picked: Partial<SystemStats> & { ts: number } = { ts: stats.ts }
  const want = (key: keyof SystemStats) => !include || include.includes(key as string)

  if (want('cpu')) picked.cpu = stats.cpu
  if (want('memory')) picked.memory = stats.memory
  if (want('gpu')) picked.gpu = stats.gpu
  if (want('disks')) picked.disks = stats.disks
  if (want('network')) picked.network = stats.network
  if (want('battery')) picked.battery = stats.battery
  if (want('os')) picked.os = stats.os
  if (include?.includes('processes')) picked.processes = stats.processes

  const summary = [
    `CPU ${Math.round(stats.cpu.usage)}%`,
    `memory ${Math.round(stats.memory.percent)}% of ${formatBytes(stats.memory.total)}`,
    stats.disks[0] ? `disk ${Math.round(stats.disks[0].percent)}% used` : null,
    stats.battery.hasBattery && stats.battery.percent != null
      ? `battery ${Math.round(stats.battery.percent)}%${stats.battery.charging ? ' charging' : ''}`
      : null
  ]
    .filter(Boolean)
    .join(', ')

  return ok(`${summary}.`, picked)
}

export const getRunningProcesses: ToolHandler = async (args) => {
  const stats = await monitoring.snapshot()
  const sortBy = args.sort_by === 'memory' ? 'memory' : 'cpu'
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))

  const sorted = [...stats.processes].sort((a, b) => (sortBy === 'memory' ? b.memoryMB - a.memoryMB : b.cpu - a.cpu))
  const top = sorted.slice(0, limit)
  if (!top.length) return fail('The process list is not available on this system.')

  const leader = top[0]
  return ok(
    `${leader.name} is the heaviest process right now at ${sortBy === 'memory' ? `${formatBytes(leader.memoryMB * 1024 * 1024)} of memory` : `${leader.cpu}% CPU`}.`,
    { sortedBy: sortBy, processes: top }
  )
}

export const setVolume: ToolHandler = async (args) => {
  const level = Number(args.level)
  if (!Number.isFinite(level) || level < 0 || level > 100) return fail('Volume must be a percentage between 0 and 100.')
  try {
    await platform().setVolume(level / 100)
    return ok(`Volume set to ${Math.round(level)}%.`, { level: Math.round(level) })
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'The system volume could not be changed.')
  }
}

export const openSettings: ToolHandler = async (args) => {
  try {
    const result = await platform().openSettings(typeof args.section === 'string' ? args.section : '')
    return ok('Opening system settings.', result)
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'System settings could not be opened.')
  }
}
