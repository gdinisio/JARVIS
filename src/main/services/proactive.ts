import type { SystemStats } from '@shared/types'
import { notifications } from './notifications'
import { settings } from './settings'
import { bus } from './bus'
import { logger } from './logging'

/**
 * Proactive observations.
 *
 * Deliberately conservative: a handful of conditions that a person would
 * genuinely want to know about, each rate-limited by the notification
 * service, and all switched off with one setting.
 */
class ProactiveService {
  private lastBatteryWarning = 0
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    bus.subscribe((event) => {
      if (event.type === 'stats') this.evaluate(event.stats)
    })
    logger.info('proactive', 'Proactive observations enabled.')
  }

  private evaluate(stats: SystemStats): void {
    if (!settings.get().privacy.proactiveSuggestions) return

    if (stats.battery.hasBattery && stats.battery.percent != null && !stats.battery.charging) {
      const level = stats.battery.percent
      if (level <= 12 && Date.now() - this.lastBatteryWarning > 20 * 60_000) {
        this.lastBatteryWarning = Date.now()
        notifications.notify(`Battery at ${Math.round(level)} per cent`, {
          body: 'Low Power Mode may be useful, or connect a charger.',
          level: 'warn',
          key: 'battery-low'
        })
      }
    }

    const disk = stats.disks[0]
    if (disk && disk.percent >= 93) {
      notifications.notify(`${disk.mount} is ${Math.round(disk.percent)} per cent full`, {
        body: 'Ask me to show what is taking up the most storage.',
        level: 'warn',
        key: `disk-${disk.mount}`
      })
    }

    if (stats.memory.percent >= 94) {
      const heaviest = stats.processes[0]
      notifications.notify('Memory is nearly exhausted', {
        body: heaviest ? `${heaviest.name} is using ${Math.round(heaviest.memoryMB)} MB.` : undefined,
        level: 'warn',
        key: 'memory-pressure'
      })
    }

    if (stats.cpu.tempC != null && stats.cpu.tempC >= 92) {
      notifications.notify('CPU temperature is high', {
        body: `${Math.round(stats.cpu.tempC)} °C. Check that the vents are clear.`,
        level: 'warn',
        key: 'cpu-temp'
      })
    }
  }
}

export const proactive = new ProactiveService()
