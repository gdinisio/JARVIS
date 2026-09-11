import si from 'systeminformation'
import { hostname, platform, arch, uptime, totalmem, freemem, release, cpus } from 'node:os'
import type { SystemStats } from '@shared/types'
import { bus } from './bus'
import { logger } from './logging'
import { now } from '../util/id'

/**
 * System monitoring.
 *
 * Different metrics change at very different rates, so each has its own
 * interval and the expensive ones (disks, GPU, OS info) are cached. Polling
 * stops entirely while the window is hidden — an idle tray app should cost
 * nothing.
 */
class MonitoringService {
  private stats: SystemStats | null = null
  private fastTimer: NodeJS.Timeout | null = null
  private slowTimer: NodeJS.Timeout | null = null
  private procTimer: NodeJS.Timeout | null = null
  private running = false

  private cache = {
    gpu: [] as SystemStats['gpu'],
    disks: [] as SystemStats['disks'],
    os: null as SystemStats['os'] | null,
    processes: [] as SystemStats['processes'],
    cpuModel: cpus()[0]?.model?.trim() ?? 'Unknown CPU',
    cpuSpeed: (cpus()[0]?.speed ?? 0) / 1000
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.refreshSlow()
    await this.refreshProcesses()
    await this.tick()
    this.fastTimer = setInterval(() => void this.tick(), 2000)
    this.slowTimer = setInterval(() => void this.refreshSlow(), 30_000)
    this.procTimer = setInterval(() => void this.refreshProcesses(), 6000)
    for (const t of [this.fastTimer, this.slowTimer, this.procTimer]) t.unref?.()
    logger.info('monitoring', 'System monitoring started.')
  }

  stop(): void {
    this.running = false
    for (const t of [this.fastTimer, this.slowTimer, this.procTimer]) if (t) clearInterval(t)
    this.fastTimer = this.slowTimer = this.procTimer = null
    logger.info('monitoring', 'System monitoring paused.')
  }

  isRunning(): boolean {
    return this.running
  }

  latest(): SystemStats | null {
    return this.stats
  }

  /** Forces a fresh read — used by the `get_system_stats` tool. */
  async snapshot(): Promise<SystemStats> {
    if (!this.stats || now() - this.stats.ts > 3000) {
      if (!this.cache.os) await this.refreshSlow()
      if (!this.cache.processes.length) await this.refreshProcesses()
      await this.tick()
    }
    return this.stats!
  }

  private async tick(): Promise<void> {
    try {
      const [load, mem, net, battery, temp] = await Promise.all([
        si.currentLoad().catch(() => null),
        si.mem().catch(() => null),
        si.networkStats().catch(() => []),
        si.battery().catch(() => null),
        si.cpuTemperature().catch(() => null)
      ])

      const primaryNet = Array.isArray(net) ? net.find((n) => (n.rx_sec ?? 0) + (n.tx_sec ?? 0) > 0) ?? net[0] : undefined
      const totalMem = mem?.total ?? totalmem()
      const usedMem = mem ? mem.total - mem.available : totalmem() - freemem()

      this.stats = {
        ts: now(),
        cpu: {
          usage: round(load?.currentLoad ?? 0),
          cores: cpus().length,
          model: this.cache.cpuModel,
          speedGHz: round(this.cache.cpuSpeed, 2),
          tempC: temp?.main && temp.main > 0 ? round(temp.main) : null
        },
        memory: {
          total: totalMem,
          used: usedMem,
          free: totalMem - usedMem,
          percent: round((usedMem / totalMem) * 100)
        },
        gpu: this.cache.gpu,
        disks: this.cache.disks,
        network: {
          online: true,
          ...(primaryNet?.iface ? { iface: primaryNet.iface } : {}),
          rxSec: primaryNet?.rx_sec != null ? Math.max(0, Math.round(primaryNet.rx_sec)) : null,
          txSec: primaryNet?.tx_sec != null ? Math.max(0, Math.round(primaryNet.tx_sec)) : null
        },
        battery: {
          hasBattery: !!battery?.hasBattery,
          percent: battery?.hasBattery ? battery.percent : null,
          charging: !!battery?.isCharging || !!battery?.acConnected,
          minutesRemaining: battery?.hasBattery && battery.timeRemaining && battery.timeRemaining > 0 ? battery.timeRemaining : null
        },
        os: this.cache.os ?? fallbackOs(),
        processes: this.cache.processes
      }
      bus.emit({ type: 'stats', stats: this.stats })
    } catch (error) {
      logger.warn('monitoring', 'Metric read failed.', { error: String(error) })
    }
  }

  private async refreshSlow(): Promise<void> {
    try {
      const [graphics, fs, osInfo] = await Promise.all([
        si.graphics().catch(() => null),
        si.fsSize().catch(() => []),
        si.osInfo().catch(() => null)
      ])

      this.cache.gpu = (graphics?.controllers ?? [])
        .filter((c) => c.model)
        .slice(0, 3)
        .map((c) => ({
          model: c.model,
          ...(c.vendor ? { vendor: c.vendor } : {}),
          vramMB: c.vram ?? null,
          usage: typeof c.utilizationGpu === 'number' ? round(c.utilizationGpu) : null,
          tempC: typeof c.temperatureGpu === 'number' ? round(c.temperatureGpu) : null
        }))

      this.cache.disks = (Array.isArray(fs) ? fs : [])
        .filter((d) => d.size > 0 && !d.mount.startsWith('/snap') && !d.mount.startsWith('/System/Volumes/'))
        .slice(0, 4)
        .map((d) => ({ mount: d.mount, total: d.size, used: d.used, percent: round(d.use) }))

      this.cache.os = {
        platform: platform(),
        distro: osInfo?.distro ?? platform(),
        release: osInfo?.release ?? release(),
        hostname: osInfo?.hostname ?? hostname(),
        arch: osInfo?.arch ?? arch(),
        uptimeSec: Math.round(uptime())
      }
    } catch (error) {
      logger.warn('monitoring', 'Slow metric read failed.', { error: String(error) })
    }
  }

  private async refreshProcesses(): Promise<void> {
    try {
      const procs = await si.processes()
      this.cache.processes = procs.list
        .filter((p) => p.name)
        .sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0) || (b.memRss ?? 0) - (a.memRss ?? 0))
        .slice(0, 12)
        .map((p) => ({
          pid: p.pid,
          name: p.name,
          cpu: round(p.cpu ?? 0),
          memoryMB: round((p.memRss ?? 0) / 1024)
        }))
    } catch (error) {
      logger.warn('monitoring', 'Process list unavailable.', { error: String(error) })
    }
  }
}

function fallbackOs(): SystemStats['os'] {
  return {
    platform: platform(),
    distro: platform(),
    release: release(),
    hostname: hostname(),
    arch: arch(),
    uptimeSec: Math.round(uptime())
  }
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export const monitoring = new MonitoringService()
