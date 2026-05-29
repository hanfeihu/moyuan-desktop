import { Check, Circle, FileText, Globe2, Image, Loader2, Package, Play, ShieldQuestion, Video } from 'lucide-react'
import { useState } from 'react'
import type { CodexTask, PluginInputField, RuntimePluginInputRequest, RuntimeTaskItem } from '@eaw/shared'

function visibleItems(task: CodexTask) {
  return (task.items ?? [])
    .filter((item) => !['assistant_message', 'reasoning', 'system', 'user_message'].includes(item.type))
    .slice(-6)
}

function compactCommandTitle(title: string) {
  const command = title.replace(/^运行命令[:：]\s*/, '').replace(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+/, '').trim()
  if (!command || command === title) return title
  if (/^rg\s/.test(command)) return '搜索代码'
  if (/^(sed|cat|nl|head|tail)\s/.test(command)) return '查看文件'
  if (/^(ls|find|pwd)\b/.test(command)) return '查看目录'
  if (/^(npm|pnpm|yarn)\s+(run\s+)?(typecheck|build|test)/.test(command)) return '运行验证'
  if (/^git\s/.test(command)) return '检查代码状态'
  return '执行命令'
}

function itemLabel(item: RuntimeTaskItem) {
  if (item.title) return item.type === 'command' ? compactCommandTitle(item.title) : item.title
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
  if (type === 'image') return <Image size={15} />
  if (type === 'video') return <Video size={15} />
  if (type === 'asset' || type === 'plugin_result') return <Package size={15} />
  return <FileText size={15} />
}

function sourceIcon(type: NonNullable<CodexTask['sources']>[number]['type']) {
  if (type === 'web') return <Globe2 size={15} />
  if (type === 'file') return <FileText size={15} />
  if (type === 'skill' || type === 'plugin') return <Package size={15} />
  return <Circle size={13} />
}

function sourceTitle(source: NonNullable<CodexTask['sources']>[number]) {
  if (source.query) return source.title
  if (source.path) return source.path
  return source.type === 'tool' ? compactCommandTitle(source.title) : source.title
}

function initialPluginValues(request: RuntimePluginInputRequest) {
  return request.fields.reduce<Record<string, unknown>>((values, field) => {
    values[field.id] = request.values?.[field.id] ?? (field.type === 'boolean' ? false : '')
    return values
  }, {})
}

function fieldValue(values: Record<string, unknown>, field: PluginInputField) {
  const value = values[field.id]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

function fileToValue(file: File) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ dataUrl: reader.result, name: file.name, size: file.size, type: file.type })
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

function PluginRequestForm({
  onSubmit,
  request,
}: {
  onSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
  request: RuntimePluginInputRequest
}) {
  const [values, setValues] = useState(() => initialPluginValues(request))
  const [submitting, setSubmitting] = useState(false)

  const setFieldValue = (field: PluginInputField, value: unknown) => {
    setValues((current) => ({ ...current, [field.id]: value }))
  }

  async function submit() {
    setSubmitting(true)
    try {
      await onSubmit(request.id, values)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="plugin-request-form">
      <div className="plugin-request-head">
        <strong>{request.title}</strong>
        <span>等待你补充后继续</span>
      </div>
      <div className="plugin-request-fields">
        {request.fields.map((field) => (
          <label className="plugin-request-field" key={field.id}>
            <span>{field.label}{field.required ? ' *' : ''}</span>
            {field.type === 'textarea' ? (
              <textarea value={fieldValue(values, field)} onChange={(event) => setFieldValue(field, event.target.value)} />
            ) : field.type === 'select' ? (
              <select value={fieldValue(values, field)} onChange={(event) => setFieldValue(field, event.target.value)}>
                <option value="">请选择</option>
                {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : field.type === 'boolean' ? (
              <input checked={Boolean(values[field.id])} onChange={(event) => setFieldValue(field, event.target.checked)} type="checkbox" />
            ) : field.type === 'image' || field.type === 'video' || field.type === 'file' ? (
              <input
                accept={field.type === 'image' ? 'image/*' : field.type === 'video' ? 'video/*' : undefined}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  void fileToValue(file).then((value) => setFieldValue(field, value))
                }}
                type="file"
              />
            ) : (
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                value={fieldValue(values, field)}
                onChange={(event) => setFieldValue(field, field.type === 'number' ? Number(event.target.value) : event.target.value)}
              />
            )}
          </label>
        ))}
      </div>
      <button className="plugin-request-submit" disabled={submitting} onClick={() => void submit()} type="button">
        {submitting ? '提交中' : '提交并继续'}
      </button>
    </div>
  )
}

export function TaskProgressCard({
  onPluginSubmit,
  task,
}: {
  onPluginSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
  task: CodexTask
}) {
  const items = visibleItems(task)
  const plan = task.plan ?? task.turns?.findLast((turn) => turn.plan?.length)?.plan ?? []
  const outputs = task.outputs ?? []
  const approvals = (task.approvals ?? []).filter((approval) => approval.status === 'pending')
  const pluginRequests = (task.pluginRequests ?? []).filter((request) => request.status === 'pending')
  const sources = task.sources ?? []
  const isLive = task.status === 'queued' || task.status === 'running'
  const hasContent = isLive || plan.length || items.length || outputs.length || approvals.length || pluginRequests.length || sources.length
  if (!hasContent) return null

  return (
    <section className="task-progress-card" aria-label="任务过程">
      <div className="task-progress-heading">任务过程</div>
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

      {sources.length ? (
        <div className="task-progress-section">
          <div className="task-progress-title">来源</div>
          <div className="task-progress-list">
            {sources.slice(0, 5).map((source) => (
              <div className="task-progress-row" key={source.id}>
                <span className="task-progress-output-icon">{sourceIcon(source.type)}</span>
                <span>{sourceTitle(source)}</span>
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

      {pluginRequests.length ? (
        <div className="task-progress-section">
          <div className="task-progress-title">插件输入</div>
          <div className="task-progress-list">
            {pluginRequests.map((request) => (
              <PluginRequestForm key={request.id} onSubmit={onPluginSubmit} request={request} />
            ))}
          </div>
        </div>
      ) : null}

      {!plan.length && isLive ? (
        <div className="task-progress-row task-progress-live">
          <span className="task-progress-mark in_progress"><Play size={13} /></span>
          <span>{task.status === 'queued' ? '任务排队中' : '任务正在执行'}</span>
        </div>
      ) : null}
    </section>
  )
}
