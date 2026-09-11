import { useStore } from '../store/useStore'
import type { JSX } from 'react'

/**
 * The task plan.
 *
 * When JARVIS decides a request needs several steps it declares them first;
 * this panel shows the steps and their live state as they execute.
 */
export function PlanPanel(): JSX.Element | null {
  const plan = useStore((s) => s.plan)
  if (!plan) return null

  const done = plan.steps.filter((step) => step.status === 'done').length
  const failed = plan.steps.some((step) => step.status === 'failed')

  return (
    <div className={`plan panel ${plan.done ? 'finished' : ''} ${failed ? 'has-failure' : ''}`}>
      <span className="corner tl" /><span className="corner br" />
      <div className="plan-head">
        <div>
          <div className="label">Task</div>
          <div className="plan-title">{plan.title}</div>
        </div>
        <div className="plan-progress mono">
          {done}/{plan.steps.length}
        </div>
      </div>

      <ol className="plan-steps">
        {plan.steps.map((step, index) => (
          <li className={`plan-step status-${step.status}`} key={step.id}>
            <span className="plan-step-index mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="plan-step-mark" aria-hidden="true">
              {step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'skipped' ? '⃠' : step.status === 'running' ? '' : '·'}
            </span>
            <span className="plan-step-label">
              {step.label}
              {step.detail && step.status !== 'pending' && <span className="plan-step-detail">{step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>

      {plan.awaitingApproval && <div className="plan-awaiting label">Awaiting your approval</div>}
    </div>
  )
}
