import { Check, Circle, FileText, Globe2, Loader2, Play, ShieldQuestion } from 'lucide-react'
import type { CodexTask, RuntimeTaskItem } from '@eaw/shared'

function visibleItems(task: CodexTask) {
  const items = task.items ?? []
  if (items.length) return items.slice(-6)
  return []
}

function itemLabel(item: RuntimeTaskItem) {
  if (item.title) return item.title
  if (item.type === 'command') return '运行命令'
  if (item.type === 'file_change') return '修改文件'
  if (item.type === 'web_search') return '网页搜索'
  if (item.type === 'tool_call') return '调用工具'
  if (item.type === 'plugin') return '调用插件'
  return '处理任务'
}

function statusIcon(status: RuntimeTaskItem['status']) {
  if (status === 'completed') return <Check size={13} />
  if (status === 'in_progress') return <Loader2 className="task-progress-spin" size={13} />
  return <Circle size={13} />
}

function outputIcon(type: NonNullable<CodexTask['outputs']>[number]['type']) {
  if (type === 'link') return <Globe2 size={15} />
  return <FileText size={15} />
}

export function TaskProgressCard({ task }: { task: CodexTask }) {
  const items = visibleItems(task)
  const plan = task.plan ?? task.turns?.findLast((turn) => turn.plan?.length)?.plan ?? []
  const outputs = task.outputs ?? []
  const approvals = (task.approvals ?? []).filter((approval) => approval.status === 'pending')
  const hasContent = plan.length || items.length || outputs.length || approvals.length
  if (!hasContent) return null

  return (
    <section className="task-progress-card" aria-label="任务过程">
      {plan.length ? (
        <div className="task-progress-section">
          <div className="task-progress-title">进度</div>
          <div className="task-progress-list">
            {plan.slice(0, 6).map((step, index) => (
              <div className="task-progress-row" key={`${step.step}-${index}`}>
                <span className={`task-progress-mark ${step.status}`}>{step.status === 'completed' ? <Check size={13} /> : step.status === 'in_progress' ? <Loader2 className="task-progress-spin" size={13} /> : <Circle size={13} />}</span>
                <span>{step.step}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {items.length ? (
        <div className="task-progress-section">
          <div className="task-progress-title">过程</div>
          <div className="task-progress-list">
            {items.map((item) => (
              <div className="task-progress-row" key={item.id}>
                <span className={`task-progress-mark ${item.status}`}>{statusIcon(item.status)}</span>
                <span>{itemLabel(item)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {outputs.length ? (
        <div className="task-progress-section">
          <div className="task-progress-title">输出</div>
          <div className="task-progress-list">
            {outputs.slice(0, 5).map((output) => (
              <div className="task-progress-row" key={output.id}>
                <span className="task-progress-output-icon">{outputIcon(output.type)}</span>
                <span>{output.title}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {approvals.length ? (
        <div className="task-progress-section">
          <div className="task-progress-title">需要确认</div>
          <div className="task-progress-list">
            {approvals.map((approval) => (
              <div className="task-progress-row" key={approval.id}>
                <span className="task-progress-approval-icon"><ShieldQuestion size={15} /></span>
                <span>{approval.title}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!plan.length && task.status === 'running' ? (
        <div className="task-progress-row task-progress-live">
          <span className="task-progress-mark in_progress"><Play size={13} /></span>
          <span>任务正在执行</span>
        </div>
      ) : null}
    </section>
  )
}
