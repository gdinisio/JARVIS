import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import { ModelViewer, type Measurement, type ViewerOptions, type ViewPreset } from '../components/ModelViewer'
import { isCadFormat, type MeshPayload, type ModelSummary } from '@shared/geometry'
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

const PRESETS: Array<{ id: ViewPreset; label: string; key: string }> = [
  { id: 'iso', label: 'Iso', key: '1' },
  { id: 'front', label: 'Front', key: '2' },
  { id: 'right', label: 'Right', key: '3' },
  { id: 'top', label: 'Top', key: '4' }
]

const SECTION_AXES = ['x', 'y', 'z'] as const

const DEFAULT_OPTIONS: ViewerOptions = {
  wireframe: false, grid: true, boundingBox: false, spin: false, shaded: true,
  section: null, measuring: false
}

export function WorkshopView(): JSX.Element {
  const models = useStore((s) => s.models)
  const activeId = useStore((s) => s.activeModel)
  const setActiveModel = useStore((s) => s.setActiveModel)
  const setModels = useStore((s) => s.setModels)
  const accent = useStore((s) => s.settings?.appearance.accent ?? '#e01f3d')

  const [mesh, setMesh] = useState<LoadedMesh | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [fitSignal, setFitSignal] = useState(0)
  const [captureSignal, setCaptureSignal] = useState(0)
  const [preset, setPreset] = useState<{ name: ViewPreset; signal: number }>({ name: 'iso', signal: 0 })
  const [options, setOptions] = useState<ViewerOptions>(DEFAULT_OPTIONS)
  const [measurement, setMeasurement] = useState<Measurement | null>(null)

  const dragDepth = useRef(0)
  const summary = useMemo(() => models.find((model) => model.id === activeId) ?? null, [models, activeId])

  /* Geometry is fetched only for the model actually on screen. */
  useEffect(() => {
    if (!activeId) {
      setMesh(null)
      return
    }
    let cancelled = false
    // Drop the old geometry immediately so nothing stale is on screen while
    // the new model is read.
    setMesh(null)
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
      else if (result.ok) setNotice(`Saved to ${result.path}.`)
    } finally {
      setBusy(false)
    }
  }, [summary])

  const onCapture = useCallback(async (dataUrl: string) => {
    const result = await window.jarvis.saveModelImage(summary?.name ?? 'model', dataUrl)
    if (!result.ok && !result.cancelled) setError(result.error ?? 'That image could not be saved.')
    else if (result.ok) setNotice(`Saved to ${result.path}.`)
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

  const toggleSection = useCallback(() => {
    setOptions((current) => ({
      ...current,
      section: current.section ? null : { axis: 'z', position: 0.5, flip: false }
    }))
  }, [])

  /* Viewport shortcuts. Single keys, so they stand down while you are typing. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.target instanceof HTMLElement && /input|textarea|select/i.test(event.target.tagName)) return

      const match = PRESETS.find((item) => item.key === event.key)
      if (match) {
        setPreset((current) => ({ name: match.id, signal: current.signal + 1 }))
        return
      }
      switch (event.key.toLowerCase()) {
        case 'f': setFitSignal((value) => value + 1); break
        case 'w': setOptions((o) => ({ ...o, wireframe: !o.wireframe })); break
        case 'g': setOptions((o) => ({ ...o, grid: !o.grid })); break
        case 'b': setOptions((o) => ({ ...o, boundingBox: !o.boundingBox })); break
        case 'r': setOptions((o) => ({ ...o, spin: !o.spin })); break
        case 'm': setOptions((o) => ({ ...o, measuring: !o.measuring })); break
        case 's': toggleSection(); break
        default: return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSection])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

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
        {measurement && <MeasureReadout measurement={measurement} />}
      </aside>

      <div className="workshop-stage">
        <div className="workshop-toolbar">
          <div className="toolbar-group">
            {PRESETS.map((item) => (
              <button
                key={item.id}
                className="btn tiny"
                title={`${item.label} view (${item.key})`}
                onClick={() => setPreset({ name: item.id, signal: preset.signal + 1 })}
                disabled={!summary}
              >
                {item.label}
              </button>
            ))}
            <button className="btn tiny" title="Fit to view (F)" onClick={() => setFitSignal((value) => value + 1)} disabled={!summary}>
              Fit
            </button>
          </div>

          <div className="toolbar-group">
            <Toggle label="Shaded" on={options.shaded} onChange={(shaded) => setOptions((o) => ({ ...o, shaded }))} />
            <Toggle label="Wireframe" hint="W" on={options.wireframe} onChange={(wireframe) => setOptions((o) => ({ ...o, wireframe }))} />
            <Toggle label="Grid" hint="G" on={options.grid} onChange={(grid) => setOptions((o) => ({ ...o, grid }))} />
            <Toggle label="Bounds" hint="B" on={options.boundingBox} onChange={(boundingBox) => setOptions((o) => ({ ...o, boundingBox }))} />
            <Toggle label="Spin" hint="R" on={options.spin} onChange={(spin) => setOptions((o) => ({ ...o, spin }))} />
            <Toggle label="Section" hint="S" on={!!options.section} onChange={toggleSection} />
            <Toggle label="Measure" hint="M" on={options.measuring} onChange={(measuring) => setOptions((o) => ({ ...o, measuring }))} />
          </div>

          <div className="toolbar-group">
            <button className="btn tiny" onClick={() => setCaptureSignal((value) => value + 1)} disabled={!summary || busy}>
              Save image
            </button>
            <button className="btn tiny" onClick={exportStl} disabled={!summary || busy}>Export STL</button>
          </div>
        </div>

        {options.section && (
          <div className="workshop-section-bar">
            <span className="label">Section</span>
            {SECTION_AXES.map((axis) => (
              <button
                key={axis}
                className={`btn tiny ${options.section?.axis === axis ? 'is-on' : ''}`}
                onClick={() => setOptions((o) => (o.section ? { ...o, section: { ...o.section, axis } } : o))}
              >
                {axis.toUpperCase()}
              </button>
            ))}
            <input
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={options.section.position}
              aria-label="Section plane position"
              onChange={(event) =>
                setOptions((o) => (o.section ? { ...o, section: { ...o.section, position: Number(event.target.value) } } : o))
              }
            />
            <button
              className="btn tiny"
              title="Show the other half"
              onClick={() => setOptions((o) => (o.section ? { ...o, section: { ...o.section, flip: !o.section.flip } } : o))}
            >
              Flip
            </button>
          </div>
        )}

        {/* The ids let a test assert that what is drawn is what is selected. */}
        <div className="viewport" data-model={summary?.id ?? ''} data-mesh={mesh?.id ?? ''}>
          {summary ? (
            <ModelViewer
              summary={summary}
              mesh={mesh}
              options={options}
              fitSignal={fitSignal}
              preset={preset}
              captureSignal={captureSignal}
              hidden={hidden}
              accent={accent}
              onMeasure={setMeasurement}
              onCapture={onCapture}
            />
          ) : (
            <EmptyStage onOpen={open} busy={busy} />
          )}

          {loading && <div className="viewport-badge">Loading geometry…</div>}
          {summary && (
            <div className="viewport-hint">
              {options.measuring
                ? 'Click two points on the model to measure between them'
                : 'Drag to orbit · Right-drag or Shift-drag to pan · Scroll to zoom'}
            </div>
          )}
          {dragging && <div className="viewport-drop">Release to open</div>}
        </div>

        {error && <div className="workshop-error" role="alert">{error}</div>}
        {notice && !error && <div className="workshop-notice" role="status">{notice}</div>}
      </div>
    </section>
  )
}

function Measurements({ summary }: { summary: ModelSummary }): JSX.Element {
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

function MeasureReadout({ measurement }: { measurement: Measurement }): JSX.Element {
  return (
    <div className="workshop-measure is-live">
      <div className="label">Between points</div>
      {measurement.distance === null ? (
        <p className="view-sub">First point set. Click a second.</p>
      ) : (
        <>
          <Row label="Distance" value={`${fmt(measurement.distance)} mm`} />
          <Row label="ΔX" value={`${fmt(measurement.delta![0])} mm`} />
          <Row label="ΔY" value={`${fmt(measurement.delta![1])} mm`} />
          <Row label="ΔZ" value={`${fmt(measurement.delta![2])} mm`} />
        </>
      )}
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

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <button
      className={`btn tiny ${on ? 'is-on' : ''}`}
      aria-pressed={on}
      title={hint ? `${label} (${hint})` : label}
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
        <li>“Make a flange, 100 mm across, with six bolt holes on a 70 mm circle.”</li>
      </ul>
    </div>
  )
}

function fmt(value: number, places = 2): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Number(value.toFixed(places))
  return rounded.toLocaleString(undefined, { maximumFractionDigits: places })
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
