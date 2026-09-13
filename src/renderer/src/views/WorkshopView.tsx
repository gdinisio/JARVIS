import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { ModelViewer, type ViewerOptions, type ViewPreset } from '../components/ModelViewer'
import { isCadFormat, type MeshPayload } from '@shared/geometry'
import type { JSX } from 'react'

/**
 * The Workshop.
 *
 * Everything JARVIS has opened or built this session, and a viewport to look at
 * it in. Models arrive here two ways: the user opens a file, or the assistant
 * builds one — both land in the same list, because from here they are the same
 * thing: geometry you can turn over and measure.
 */

type LoadedMesh = MeshPayload & { id: string }

const PRESETS: Array<{ id: ViewPreset; label: string }> = [
  { id: 'iso', label: 'Iso' },
  { id: 'front', label: 'Front' },
  { id: 'right', label: 'Right' },
  { id: 'top', label: 'Top' }
]

export function WorkshopView(): JSX.Element {
  const models = useStore((s) => s.models)
  const activeId = useStore((s) => s.activeModel)
  const setActiveModel = useStore((s) => s.setActiveModel)
  const setModels = useStore((s) => s.setModels)
  const accent = useStore((s) => s.settings?.appearance.accent ?? '#e01f3d')

  const [mesh, setMesh] = useState<LoadedMesh | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [fitSignal, setFitSignal] = useState(0)
  const [preset, setPreset] = useState<{ name: ViewPreset; signal: number }>({ name: 'iso', signal: 0 })
  const [options, setOptions] = useState<ViewerOptions>({
    wireframe: false, grid: true, boundingBox: false, spin: false, shaded: true
  })

  const dragDepth = useRef(0)
  const summary = useMemo(() => models.find((model) => model.id === activeId) ?? null, [models, activeId])

  /* Geometry is fetched only for the model actually on screen. */
  useEffect(() => {
    if (!activeId) {
      setMesh(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void window.jarvis.mesh(activeId).then((result) => {
      if (cancelled) return
      setLoading(false)
      if (!result.ok || !result.positions || !result.normals || !result.indices) {
        setError(result.error ?? 'That model could not be loaded.')
        setMesh(null)
        return
      }
      setHidden(new Set())
      setMesh({
        id: activeId,
        positions: result.positions,
        normals: result.normals,
        indices: result.indices,
        groups: result.groups ?? []
      })
    })
    return () => {
      cancelled = true
    }
  }, [activeId])

  const open = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.jarvis.pickModel()
      if (!result.ok && !result.cancelled) setError(result.error ?? 'That file could not be opened.')
    } finally {
      setBusy(false)
    }
  }, [])

  const exportStl = useCallback(async () => {
    if (!summary) return
    setBusy(true)
    try {
      const result = await window.jarvis.exportModel(summary.id)
      if (!result.ok && !result.cancelled) setError(result.error ?? 'That model could not be exported.')
    } finally {
      setBusy(false)
    }
  }, [summary])

  const close = useCallback(async (id: string) => {
    await window.jarvis.closeModel(id)
    const result = await window.jarvis.models()
    if (result.ok) setModels(result.models)
  }, [setModels])

  /* Drag and drop. The path is resolved in the preload, never here. */
  const onDrop = useCallback(async (event: React.DragEvent) => {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.jarvis.dropModel(file)
      if (!result.ok) setError(result.error ?? 'That file could not be opened.')
    } finally {
      setBusy(false)
    }
  }, [])

  const togglePart = useCallback((index: number) => {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }, [])

  const parts = mesh?.groups.length ? mesh.groups : summary ? [{ name: summary.name, start: 0, count: 0 }] : []

  return (
    <section
      className={`workshop ${dragging ? 'workshop-dropping' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault()
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <aside className="workshop-rail">
        <header className="workshop-rail-head">
          <h1 className="view-title">Workshop</h1>
          <button className="btn tiny" onClick={open} disabled={busy}>Open file…</button>
        </header>

        <div className="workshop-list" role="listbox" aria-label="Open models">
          {models.length === 0 && <p className="view-sub">Nothing loaded yet.</p>}
          {models.map((model) => (
            <div
              key={model.id}
              role="option"
              aria-selected={model.id === activeId}
              tabIndex={0}
              className={`workshop-item ${model.id === activeId ? 'is-active' : ''}`}
              onClick={() => setActiveModel(model.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setActiveModel(model.id)
                }
              }}
            >
              <div className="workshop-item-main">
                <span className="workshop-item-name">{model.name}</span>
                <span className="workshop-item-meta">
                  {model.origin === 'generated' ? 'BUILT' : model.format.toUpperCase()}
                  {isCadFormat(model.format) ? ' · CAD' : ''}
                  {' · '}
                  {model.stats.triangles.toLocaleString()} tri
                </span>
              </div>
              <button
                className="workshop-close"
                title="Close model"
                aria-label={`Close ${model.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void close(model.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {summary && parts.length > 1 && (
          <div className="workshop-parts">
            <div className="label">Parts</div>
            {parts.map((part, index) => (
              <label key={`${part.name}-${index}`} className="workshop-part">
                <input
                  type="checkbox"
                  checked={!hidden.has(index)}
                  onChange={() => togglePart(index)}
                />
                <span>{part.name}</span>
              </label>
            ))}
          </div>
        )}

        {summary && <Measurements summary={summary} />}
      </aside>

      <div className="workshop-stage">
        <div className="workshop-toolbar">
          <div className="toolbar-group">
            {PRESETS.map((item) => (
              <button
                key={item.id}
                className="btn tiny"
                onClick={() => setPreset({ name: item.id, signal: preset.signal + 1 })}
                disabled={!summary}
              >
                {item.label}
              </button>
            ))}
            <button className="btn tiny" onClick={() => setFitSignal((value) => value + 1)} disabled={!summary}>
              Fit
            </button>
          </div>

          <div className="toolbar-group">
            <Toggle label="Shaded" on={options.shaded} onChange={(shaded) => setOptions((o) => ({ ...o, shaded }))} />
            <Toggle label="Wireframe" on={options.wireframe} onChange={(wireframe) => setOptions((o) => ({ ...o, wireframe }))} />
            <Toggle label="Grid" on={options.grid} onChange={(grid) => setOptions((o) => ({ ...o, grid }))} />
            <Toggle label="Bounds" on={options.boundingBox} onChange={(boundingBox) => setOptions((o) => ({ ...o, boundingBox }))} />
            <Toggle label="Spin" on={options.spin} onChange={(spin) => setOptions((o) => ({ ...o, spin }))} />
          </div>

          <div className="toolbar-group">
            <button className="btn tiny" onClick={exportStl} disabled={!summary || busy}>Export STL</button>
          </div>
        </div>

        <div className="viewport">
          {summary ? (
            <ModelViewer
              summary={summary}
              mesh={mesh}
              options={options}
              fitSignal={fitSignal}
              preset={preset}
              hidden={hidden}
              accent={accent}
            />
          ) : (
            <EmptyStage onOpen={open} busy={busy} />
          )}

          {loading && <div className="viewport-badge">Loading geometry…</div>}
          {summary && (
            <div className="viewport-hint">
              Drag to orbit · Right-drag or Shift-drag to pan · Scroll to zoom
            </div>
          )}
          {dragging && <div className="viewport-drop">Release to open</div>}
        </div>

        {error && <div className="workshop-error" role="alert">{error}</div>}
      </div>
    </section>
  )
}

function Measurements({ summary }: { summary: NonNullable<ReturnType<typeof useStore.getState>['models']>[number] }): JSX.Element {
  const [x, y, z] = summary.bounds.size
  const volume = summary.stats.volumeMm3
  return (
    <div className="workshop-measure">
      <div className="label">Measurements</div>
      <Row label="Width (X)" value={`${fmt(x)} mm`} />
      <Row label="Depth (Y)" value={`${fmt(y)} mm`} />
      <Row label="Height (Z)" value={`${fmt(z)} mm`} />
      {volume !== undefined && volume > 0 && <Row label="Volume" value={`${fmt(volume, 1)} mm³`} />}
      {summary.stats.surfaceAreaMm2 !== undefined && summary.stats.surfaceAreaMm2 > 0 && (
        <Row label="Surface" value={`${fmt(summary.stats.surfaceAreaMm2, 1)} mm²`} />
      )}
      <Row label="Triangles" value={summary.stats.triangles.toLocaleString()} />
      <Row label="Vertices" value={summary.stats.vertices.toLocaleString()} />
      {summary.path && <Row label="Source" value={tail(summary.path)} title={summary.path} mono />}
    </div>
  )
}

function Row({ label, value, title, mono }: { label: string; value: string; title?: string; mono?: boolean }): JSX.Element {
  return (
    <div className="measure-row">
      <span className="measure-label">{label}</span>
      <span className={`measure-value ${mono ? 'mono' : ''}`} title={title ?? value}>{value}</span>
    </div>
  )
}

/**
 * Keeps the end of a path, which is the informative half.
 *
 * Done here rather than with CSS: `direction: rtl` truncation reorders the
 * trailing separator and shows "…s/fixtures/plate.step/".
 */
function tail(path: string, max = 26): string {
  if (path.length <= max) return path
  return `…${path.slice(path.length - max + 1)}`
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button
      className={`btn tiny ${on ? 'is-on' : ''}`}
      aria-pressed={on}
      onClick={() => onChange(!on)}
    >
      {label}
    </button>
  )
}

function EmptyStage({ onOpen, busy }: { onOpen: () => void; busy: boolean }): JSX.Element {
  return (
    <div className="viewport-empty">
      <div className="viewport-empty-mark" aria-hidden="true" />
      <div className="viewport-empty-title">Nothing on the table</div>
      <p className="viewport-empty-body">
        Drop a model here, or ask for one. STL, OBJ, PLY and 3MF meshes; STEP, IGES and BREP CAD.
      </p>
      <div className="viewport-empty-actions">
        <button className="btn" onClick={onOpen} disabled={busy}>Open a file</button>
      </div>
      <ul className="viewport-empty-hints">
        <li>“Open the bracket STEP file in my Downloads.”</li>
        <li>“Build a 40 by 20 by 10 plate with a 4 mm hole through the middle.”</li>
        <li>“Make a hex nut, 13 mm across the flats, 8 mm tall, M8 thread clearance.”</li>
      </ul>
    </div>
  )
}

function fmt(value: number, places = 2): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Number(value.toFixed(places))
  return rounded.toLocaleString(undefined, { maximumFractionDigits: places })
}
