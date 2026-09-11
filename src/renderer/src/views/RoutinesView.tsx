import { useState } from 'react'
import type { Routine, RoutineAction } from '@shared/types'
import { useStore } from '../store/useStore'
import { relativeTime } from '../lib/format'
import type { JSX } from 'react'

/**
 * Routines.
 *
 * Saved multi-step sequences. They can be created here, or simply described
 * to JARVIS — "when I say start work, open VS Code, Chrome and Slack" — which
 * saves the same structure through the `create_routine` tool.
 */
export function RoutinesView(): JSX.Element {
  const routines = useStore((s) => s.routines)
  const tools = useStore((s) => s.tools)
  const [editing, setEditing] = useState<Routine | null>(null)
  const [creating, setCreating] = useState(false)

  const blank: Routine = {
    id: '',
    name: '',
    description: '',
    actions: [{ tool: 'open_application', args: { name: '' } }],
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runCount: 0,
    triggers: []
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1 className="view-title">Routines</h1>
          <p className="view-sub">Named sequences you can run by voice, from the tray, or from here.</p>
        </div>
        <div className="view-actions">
          <button className="btn primary" onClick={() => { setEditing(blank); setCreating(true) }}>New routine</button>
        </div>
      </header>

      {routines.length === 0 && !editing ? (
        <div className="empty">
          <div>No routines saved.</div>
          <div className="empty-hint">
            Try saying: “Create a routine called Work Mode that opens VS Code, Chrome and Slack.”
          </div>
        </div>
      ) : (
        <div className="card-grid">
          {routines.map((routine) => (
            <article className={`routine-card panel ${routine.enabled ? '' : 'disabled'}`} key={routine.id}>
              <span className="corner tl" /><span className="corner br" />
              <header className="routine-head">
                <div>
                  <h2 className="routine-name">{routine.name}</h2>
                  {routine.description && <p className="routine-desc">{routine.description}</p>}
                </div>
                <label className="switch" title={routine.enabled ? 'Enabled' : 'Disabled'}>
                  <input
                    type="checkbox"
                    checked={routine.enabled}
                    onChange={(event) =>
                      void window.jarvis.saveRoutine({ ...routine, enabled: event.target.checked })
                    }
                  />
                  <span className="switch-track"><span className="switch-thumb" /></span>
                </label>
              </header>

              <ol className="routine-steps">
                {routine.actions.map((action, index) => (
                  <li key={`${routine.id}-${index}`}>
                    <span className="mono">{action.tool.replace(/_/g, ' ')}</span>
                    <span className="routine-args">{summariseArgs(action.args)}</span>
                  </li>
                ))}
              </ol>

              {routine.triggers.length > 0 && (
                <div className="routine-triggers">
                  {routine.triggers.map((trigger) => (
                    <span className="chip" key={trigger}>“{trigger}”</span>
                  ))}
                </div>
              )}

              <footer className="routine-foot">
                <span className="routine-meta label">
                  {routine.runCount} run{routine.runCount === 1 ? '' : 's'}
                  {routine.lastRun ? ` · ${relativeTime(routine.lastRun)}` : ''}
                </span>
                <div className="routine-buttons">
                  <button className="btn ghost tiny" onClick={() => void window.jarvis.duplicateRoutine(routine.id)}>Duplicate</button>
                  <button className="btn ghost tiny" onClick={() => { setEditing(routine); setCreating(false) }}>Edit</button>
                  <button
                    className="btn ghost tiny danger"
                    onClick={() => {
                      if (confirm(`Delete the routine “${routine.name}”?`)) void window.jarvis.deleteRoutine(routine.id)
                    }}
                  >
                    Delete
                  </button>
                  <button className="btn primary tiny" disabled={!routine.enabled} onClick={() => void window.jarvis.runRoutine(routine.name)}>
                    Run
                  </button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <RoutineEditor
          routine={editing}
          creating={creating}
          toolNames={tools.map((tool) => tool.name)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function RoutineEditor({
  routine,
  creating,
  toolNames,
  onClose
}: {
  routine: Routine
  creating: boolean
  toolNames: string[]
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(routine.name)
  const [description, setDescription] = useState(routine.description ?? '')
  const [triggers, setTriggers] = useState(routine.triggers.join(', '))
  const [actions, setActions] = useState<RoutineAction[]>(
    routine.actions.length ? routine.actions : [{ tool: 'open_application', args: {} }]
  )
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name.trim()) {
      setError('The routine needs a name.')
      return
    }
    const cleaned = actions.filter((action) => action.tool.trim())
    if (!cleaned.length) {
      setError('Add at least one step.')
      return
    }
    const result = await window.jarvis.saveRoutine({
      ...(creating ? {} : { id: routine.id }),
      name: name.trim(),
      description: description.trim() || undefined,
      actions: cleaned,
      triggers: triggers.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean),
      enabled: routine.enabled
    })
    if (result?.ok) onClose()
    else setError('That routine could not be saved.')
  }

  return (
    <div className="confirm-backdrop" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="editor panel" role="dialog" aria-modal="true" aria-label={creating ? 'New routine' : `Edit ${routine.name}`}>
        <span className="corner tl" /><span className="corner br" />
        <h2 className="editor-title">{creating ? 'New routine' : `Edit “${routine.name}”`}</h2>

        <label className="field-row">
          <span className="label">Name</span>
          <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Work Mode" />
        </label>

        <label className="field-row">
          <span className="label">Description</span>
          <input className="field" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Everything I need to start the day" />
        </label>

        <label className="field-row">
          <span className="label">Trigger phrases</span>
          <input className="field" value={triggers} onChange={(event) => setTriggers(event.target.value)} placeholder="start work, work mode" />
        </label>

        <div className="editor-steps">
          <div className="label">Steps</div>
          {actions.map((action, index) => (
            <div className="editor-step" key={index}>
              <select
                className="field"
                value={action.tool}
                onChange={(event) => {
                  const next = [...actions]
                  next[index] = { ...next[index], tool: event.target.value }
                  setActions(next)
                }}
              >
                {toolNames.map((tool) => (
                  <option key={tool} value={tool}>{tool.replace(/_/g, ' ')}</option>
                ))}
              </select>
              <input
                className="field mono"
                value={JSON.stringify(action.args ?? {})}
                onChange={(event) => {
                  const next = [...actions]
                  try {
                    next[index] = { ...next[index], args: JSON.parse(event.target.value || '{}') }
                    setError(null)
                  } catch {
                    setError('Arguments must be valid JSON, e.g. {"name": "Chrome"}')
                    return
                  }
                  setActions(next)
                }}
                placeholder='{"name": "Chrome"}'
                spellCheck={false}
              />
              <button
                className="btn ghost tiny"
                onClick={() => setActions(actions.filter((_, i) => i !== index))}
                disabled={actions.length === 1}
                aria-label="Remove step"
              >
                ✕
              </button>
            </div>
          ))}
          <button className="btn ghost tiny" onClick={() => setActions([...actions, { tool: 'open_application', args: {} }])}>
            Add step
          </button>
        </div>

        {error && <div className="editor-error">{error}</div>}

        <div className="confirm-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => void save()}>Save routine</button>
        </div>
      </div>
    </div>
  )
}

function summariseArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const entries = Object.entries(args).filter(([, value]) => value !== undefined && value !== '')
  if (!entries.length) return ''
  return entries.map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`).join(' · ')
}
