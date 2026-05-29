import { Check, Circle, FileText, Globe2, Image, Loader2, Package, Play, ShieldQuestion, Upload, Video, X } from 'lucide-react'
import { useEffect, useState } from 'react'
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

type PluginFileValue = {
  dataUrl?: string
  name?: string
  size?: number
  type?: string
  url?: string
}

function fileValues(values: Record<string, unknown>, field: PluginInputField) {
  const value = values[field.id]
  if (Array.isArray(value)) return value.filter(isFileValue)
  if (isFileValue(value)) return [value]
  return []
}

function isFileValue(value: unknown): value is PluginFileValue {
  return Boolean(value && typeof value === 'object' && ('dataUrl' in value || 'url' in value || 'name' in value))
}

function fileKindLabel(field: PluginInputField) {
  if (field.type === 'image') return '图片'
  if (field.type === 'video') return '视频'
  if (field.type === 'audio') return '音频'
  return '文件'
}

function fileIcon(field: PluginInputField) {
  if (field.type === 'image') return <Image size={18} />
  if (field.type === 'video') return <Video size={18} />
  if (field.type === 'audio') return <Circle size={16} />
  return <FileText size={18} />
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
  onCancel,
  onSubmitted,
  onSubmit,
  request,
}: {
  onCancel?: () => void
  onSubmitted?: () => void
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
      onSubmitted?.()
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
              <textarea placeholder={field.placeholder} value={fieldValue(values, field)} onChange={(event) => setFieldValue(field, event.target.value)} />
            ) : field.type === 'select' ? (
              <select value={fieldValue(values, field)} onChange={(event) => setFieldValue(field, event.target.value)}>
                <option value="">请选择</option>
                {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : field.type === 'boolean' ? (
              <input checked={Boolean(values[field.id])} onChange={(event) => setFieldValue(field, event.target.checked)} type="checkbox" />
            ) : field.type === 'image' || field.type === 'video' || field.type === 'audio' || field.type === 'file' ? (
              <span className="plugin-file-field">
                <span className="plugin-file-dropzone">
                  <span className="plugin-file-icon"><Upload size={18} /></span>
                  <span>
                    <strong>添加{fileKindLabel(field)}</strong>
                    <small>{(field.maxFiles ?? 1) > 1 ? `最多 ${field.maxFiles} 个，已选 ${fileValues(values, field).length} 个` : '选择一个素材'}</small>
                  </span>
                  <input
                    accept={field.type === 'image' ? 'image/*' : field.type === 'video' ? 'video/*' : field.type === 'audio' ? 'audio/*' : undefined}
                    multiple={(field.maxFiles ?? 1) > 1}
                    onChange={(event) => {
                      const files = Array.from(event.target.files ?? [])
                      if (!files.length) return
                      void Promise.all(files.map(fileToValue)).then((nextValues) => {
                        const maxFiles = field.maxFiles ?? 1
                        if (maxFiles > 1) {
                          const merged = [...fileValues(values, field), ...nextValues].slice(0, maxFiles)
                          setFieldValue(field, merged)
                        } else {
                          setFieldValue(field, nextValues[0])
                        }
                        event.target.value = ''
                      })
                    }}
                    type="file"
                  />
                </span>
                {fileValues(values, field).length ? (
                  <span className="plugin-file-list">
                    {fileValues(values, field).map((file, index) => (
                      <span className="plugin-file-card" key={`${file.name ?? file.url ?? index}-${index}`}>
                        {field.type === 'image' && (file.dataUrl || file.url) ? (
                          <img alt="" src={file.dataUrl ?? file.url} />
                        ) : (
                          <span className="plugin-file-card-icon">{fileIcon(field)}</span>
                        )}
                        <span className="plugin-file-card-main">
                          <strong>{file.name ?? `${fileKindLabel(field)} ${index + 1}`}</strong>
                          <small>{field.type === 'image' ? `图片${index + 1}` : field.type === 'video' ? `视频${index + 1}` : field.type === 'audio' ? `音频${index + 1}` : `文件${index + 1}`}</small>
                        </span>
                        <button
                          title="移除"
                          type="button"
                          onClick={() => {
                            const current = fileValues(values, field)
                            const next = current.filter((_, fileIndex) => fileIndex !== index)
                            setFieldValue(field, (field.maxFiles ?? 1) > 1 ? next : '')
                          }}
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : (
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                placeholder={field.placeholder}
                value={fieldValue(values, field)}
                onChange={(event) => setFieldValue(field, field.type === 'number' ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value)}
              />
            )}
            {field.helpText ? <small className="plugin-request-help">{field.helpText}</small> : null}
          </label>
        ))}
      </div>
      <div className="plugin-request-actions">
        {onCancel ? (
          <button className="plugin-request-cancel" disabled={submitting} onClick={onCancel} type="button">
            稍后填写
          </button>
        ) : null}
        <button className="plugin-request-submit" disabled={submitting} onClick={() => void submit()} type="button">
          {submitting ? '提交中' : '提交并继续'}
        </button>
      </div>
    </div>
  )
}

function PluginRequestModal({
  onClose,
  onSubmit,
  request,
}: {
  onClose: () => void
  onSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
  request: RuntimePluginInputRequest
}) {
  return (
    <div className="plugin-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="plugin-modal" aria-label={request.title} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="plugin-modal-close" title="关闭" type="button" onClick={onClose}>
          <X size={16} />
        </button>
        <PluginRequestForm onCancel={onClose} onSubmitted={onClose} onSubmit={onSubmit} request={request} />
      </section>
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
  const pluginRequestIds = pluginRequests.map((request) => request.id).join('|')
  const [activePluginRequestId, setActivePluginRequestId] = useState<string | null | undefined>(undefined)
  const activePluginRequest = pluginRequests.find((request) => request.id === activePluginRequestId) ?? null
  const sources = task.sources ?? []
  const isLive = task.status === 'queued' || task.status === 'running'
  const hasContent = isLive || plan.length || items.length || outputs.length || approvals.length || pluginRequests.length || sources.length

  useEffect(() => {
    if (!pluginRequests.length) {
      setActivePluginRequestId(undefined)
      return
    }
    setActivePluginRequestId((current) => {
      if (current === null) return null
      if (current && pluginRequests.some((request) => request.id === current)) return current
      return pluginRequests[0]?.id ?? undefined
    })
  }, [pluginRequestIds])

  if (!hasContent) return null

  return (
    <>
      {activePluginRequest ? (
        <PluginRequestModal
          onClose={() => setActivePluginRequestId(null)}
          onSubmit={onPluginSubmit}
          request={activePluginRequest}
        />
      ) : null}
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
              <button className="task-progress-plugin-row" key={request.id} onClick={() => setActivePluginRequestId(request.id)} type="button">
                <span className="task-progress-output-icon"><Package size={15} /></span>
                <span>
                  <strong>{request.title}</strong>
                  <small>等待你补充后继续</small>
                </span>
              </button>
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
    </>
  )
}
