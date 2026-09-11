import { useStore } from '../store/useStore'
import { formatBytes, formatRate, formatUptime } from '../lib/format'
import type { JSX } from 'react'

/**
 * The system HUD.
 *
 * Live metrics, updated on the main process's own schedule (2 s for CPU and
 * memory, 30 s for disks and GPU). Values transition rather than jump, and
 * nothing animates for its own sake.
 */

function Meter({
  label,
  value,
  display,
  detail,
  warn
}: {
  label: string
  value: number | null
  display: string
  detail?: string
  warn?: boolean
}): JSX.Element {
  const percent = value == null ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div className={`meter ${warn ? 'warn' : ''}`}>
      <div className="meter-head">
        <span className="label">{label}</span>
        <span className="meter-value mono">{display}</span>
      </div>
      <div className="meter-track" role="meter" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="meter-fill" style={{ transform: `scaleX(${percent / 100})` }} />
        <div className="meter-ticks" aria-hidden="true" />
      </div>
      {detail && <div className="meter-detail">{detail}</div>}
    </div>
  )
}

export function Hud(): JSX.Element {
  const stats = useStore((s) => s.stats)
  const density = useStore((s) => s.settings?.appearance.hudDensity ?? 'standard')

  if (!stats) {
    return (
      <div className="hud panel">
        <span className="corner tl" /><span className="corner br" />
        <div className="hud-title label">System</div>
        <div className="empty">Reading system metrics…</div>
      </div>
    )
  }

  const disk = stats.disks[0]
  const gpu = stats.gpu[0]

  return (
    <div className="hud panel">
      <span className="corner tl" /><span className="corner br" />
      <div className="hud-title">
        <span className="label">System</span>
        <span className="hud-host mono">{stats.os.hostname}</span>
      </div>

      <div className="hud-metrics">
        <Meter
          label="CPU"
          value={stats.cpu.usage}
          display={`${Math.round(stats.cpu.usage)}%`}
          detail={density !== 'minimal' ? `${stats.cpu.cores} cores${stats.cpu.tempC ? ` · ${Math.round(stats.cpu.tempC)}°C` : ''}` : undefined}
          warn={stats.cpu.usage > 88}
        />
        <Meter
          label="Memory"
          value={stats.memory.percent}
          display={`${Math.round(stats.memory.percent)}%`}
          detail={density !== 'minimal' ? `${formatBytes(stats.memory.used)} of ${formatBytes(stats.memory.total)}` : undefined}
          warn={stats.memory.percent > 90}
        />
        {disk && (
          <Meter
            label="Disk"
            value={disk.percent}
            display={`${Math.round(disk.percent)}%`}
            detail={density !== 'minimal' ? `${formatBytes(disk.total - disk.used)} free · ${disk.mount}` : undefined}
            warn={disk.percent > 92}
          />
        )}
        {stats.battery.hasBattery && stats.battery.percent != null && (
          <Meter
            label="Battery"
            value={stats.battery.percent}
            display={`${Math.round(stats.battery.percent)}%`}
            detail={
              stats.battery.charging
                ? 'Charging'
                : stats.battery.minutesRemaining
                  ? `${Math.floor(stats.battery.minutesRemaining / 60)}h ${stats.battery.minutesRemaining % 60}m remaining`
                  : 'On battery'
            }
            warn={!stats.battery.charging && stats.battery.percent < 15}
          />
        )}
      </div>

      {density !== 'minimal' && (
        <div className="hud-grid">
          <div className="hud-cell">
            <span className="label">Network</span>
            <span className="mono">
              ↓ {formatRate(stats.network.rxSec)} · ↑ {formatRate(stats.network.txSec)}
            </span>
          </div>
          {gpu && (
            <div className="hud-cell">
              <span className="label">GPU</span>
              <span className="mono" title={gpu.model}>
                {gpu.usage != null ? `${Math.round(gpu.usage)}% · ` : ''}
                {truncate(gpu.model, 22)}
              </span>
            </div>
          )}
          <div className="hud-cell">
            <span className="label">System</span>
            <span className="mono">{truncate(`${stats.os.distro} ${stats.os.release}`, 26)}</span>
          </div>
          <div className="hud-cell">
            <span className="label">Uptime</span>
            <span className="mono">{formatUptime(stats.os.uptimeSec)}</span>
          </div>
        </div>
      )}

      {density === 'dense' && stats.processes.length > 0 && (
        <div className="hud-processes">
          <div className="label">Top processes</div>
          {stats.processes.slice(0, 5).map((process) => (
            <div className="process-row" key={process.pid}>
              <span className="process-name">{truncate(process.name, 18)}</span>
              <span className="process-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${Math.min(1, process.cpu / 100)})` }} />
              </span>
              <span className="process-value mono">{process.cpu.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
