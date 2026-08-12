import { Check, Circle, FileText, Globe2, Image, Loader2, Package, Search, ShieldQuestion, Upload, Video, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { runtimeTaskStatusExplanation, type CodexTask, type GeneratedAssetRecord, type PluginInputField, type RuntimePluginInputRequest, type RuntimeTaskItem, type UserWorkspaceSummary } from '@eaw/shared'
import { enterpriseFetch } from '../../api'
import { errorLogDetails, logClientEvent } from '../../logger'
import { formatElapsed } from '../../utils/format'
import { taskResources } from './ResourceCards'

function visibleItems(task: CodexTask) {
  return (task.items ?? [])
    .filter((item) => {
      if (['assistant_message', 'reasoning', 'system', 'user_message'].includes(item.type)) return false
      if (item.type === 'plugin' && item.status === 'declined') return false
      const rawType = typeof item.metadata?.type === 'string' ? item.metadata.type.replace(/[_\s-]/g, '').toLowerCase() : ''
      return rawType !== 'usermessage' && rawType !== 'agentmessage'
    })
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
  if (status === 'failed') return <Circle size={13} />
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
    values[field.id] = request.values?.[field.id] ?? defaultPluginFieldValue(field)
    return values
  }, {})
}

function defaultPluginFieldValue(field: PluginInputField) {
  if (field.id === 'generateAudio') return true
  if (field.id === 'returnLastFrame') return true
  if (field.id === 'watermark') return false
  if (field.id === 'ratio') return 'adaptive'
  if (field.type === 'boolean') return false
  return ''
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

type PluginResourceLibraryItem = {
  createdAt: string
  id: string
  model?: string
  title: string
  type: 'image' | 'video'
  url: string
}

function readPayload<T>(response: Response) {
  return response.json().then((payload: { data?: T; error?: string }) => {
    if (!response.ok || payload.data == null) throw new Error(payload.error ?? '请求失败')
    return payload.data
  })
}

function assetToLibraryResource(asset: GeneratedAssetRecord): PluginResourceLibraryItem | undefined {
  const url = asset.storageUrl || asset.url
  const lastFrameUrl = typeof asset.metadata?.lastFrameUrl === 'string' ? asset.metadata.lastFrameUrl : undefined
  if (!url && !lastFrameUrl) return undefined
  return {
    createdAt: asset.createdAt,
    id: asset.id,
    model: asset.model,
    title: asset.type === 'video' ? '生成视频' : '生成图片',
    type: asset.type,
    url: url || lastFrameUrl || '',
  }
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

function resourceLibraryFromTasks(tasks: CodexTask[]) {
  return tasks
    .flatMap((task) => taskResources(task))
    .filter((resource) => (resource.type === 'image' || resource.type === 'video') && Boolean(resource.url))
    .map((resource) => ({
      createdAt: resource.createdAt,
      id: resource.id,
      model: resource.model,
      title: resource.title,
      type: resource.type as 'image' | 'video',
      url: resource.url ?? '',
    }))
}

function mergeResourceLibraries(remoteResources: PluginResourceLibraryItem[], localResources: PluginResourceLibraryItem[]) {
  const seen = new Set<string>()
  return [...remoteResources, ...localResources]
    .filter((resource) => {
      const key = resource.url || resource.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

function libraryResourcesForField(resources: PluginResourceLibraryItem[], field: PluginInputField) {
  return resources.filter((resource) => field.type === 'file' || resource.type === field.type)
}

function resourceToFileValue(resource: PluginResourceLibraryItem): PluginFileValue {
  return {
    name: resource.title,
    type: resource.type === 'image' ? 'image/*' : 'video/*',
    url: resource.url,
  }
}

function mergeFileValues(values: Record<string, unknown>, field: PluginInputField, nextValues: PluginFileValue[]) {
  const maxFiles = field.maxFiles ?? 1
  if (maxFiles > 1) {
    const seen = new Set<string>()
    return [...fileValues(values, field), ...nextValues]
      .filter((item) => {
        const key = item.url || item.name || item.dataUrl || ''
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, maxFiles)
  }
  return nextValues[0] ?? ''
}

function ResourceLibraryPicker({
  availableSlots,
  field,
  onClose,
  onConfirm,
  resources,
}: {
  availableSlots: number
  field: PluginInputField
  onClose: () => void
  onConfirm: (resources: PluginResourceLibraryItem[]) => void
  resources: PluginResourceLibraryItem[]
}) {
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<PluginResourceLibraryItem[]>([])
  const maxFiles = field.maxFiles ?? 1
  const selectedIds = new Set(selection.map((resource) => resource.id))
  const filteredResources = resources.filter((resource) => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return true
    return [resource.title, resource.model, resource.type]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalizedQuery))
  })

  function toggleResource(resource: PluginResourceLibraryItem) {
    setSelection((current) => {
      if (current.some((item) => item.id === resource.id)) return current.filter((item) => item.id !== resource.id)
      if (availableSlots <= 0) return current
      if (maxFiles <= 1) return [resource]
      if (current.length >= availableSlots) return current
      return [...current, resource]
    })
  }

  return (
    <span className="resource-picker-popover" role="presentation" onMouseDown={onClose}>
      <span className="resource-picker-panel" aria-label={`选择${field.label}`} aria-modal="true" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <span className="resource-picker-head">
          <span>
            <strong>选择{field.label}</strong>
            <small>{availableSlots <= 1 ? '选择 1 个资源' : `最多还可选 ${availableSlots} 个资源`}</small>
          </span>
          <button aria-label="关闭资源选择" onClick={onClose} type="button">
            <X size={14} />
          </button>
        </span>
        <label className="resource-picker-search">
          <Search size={14} />
          <input onChange={(event) => setQuery(event.target.value)} placeholder="搜索图片或视频" value={query} />
        </label>
        <span className="resource-picker-grid">
          {filteredResources.map((resource) => {
            const selected = selectedIds.has(resource.id)
            const limitReached = !selected && maxFiles > 1 && selection.length >= availableSlots
            return (
              <button
                className={selected ? 'selected' : ''}
                disabled={limitReached}
                key={resource.id}
                onClick={() => toggleResource(resource)}
                type="button"
              >
                <span className={`resource-picker-thumb ${resource.type}`}>
                  {resource.type === 'video' ? <video muted preload="metadata" src={resource.url} /> : <img alt="" src={resource.url} />}
                  {selected ? <span className="resource-picker-check"><Check size={12} /></span> : null}
                </span>
                <strong>{resource.title}</strong>
                <small>{resource.model || (resource.type === 'video' ? '视频' : '图片')}</small>
              </button>
            )
          })}
          {!filteredResources.length ? <span className="resource-picker-empty">没有符合条件的资源</span> : null}
        </span>
        <span className="resource-picker-actions">
          <small>已选 {selection.length} 个</small>
          <span>
            <button onClick={onClose} type="button">取消</button>
            <button className="primary" disabled={!selection.length} onClick={() => onConfirm(selection)} type="button">确认选择</button>
          </span>
        </span>
      </span>
    </span>
  )
}

function PluginRequestForm({
  onDefer,
  onSubmitted,
  onSubmit,
  resourceLibrary,
  request,
}: {
  onDefer?: (requestId: string) => void | Promise<void>
  onSubmitted?: () => void
  onSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
  resourceLibrary: PluginResourceLibraryItem[]
  request: RuntimePluginInputRequest
}) {
  const [values, setValues] = useState(() => initialPluginValues(request))
  const [submitting, setSubmitting] = useState(false)
  const [deferring, setDeferring] = useState(false)
  const isInteractiveVideo = request.inputUi?.variant === 'video' || request.pluginId === 'interactive-video-request'
  const mediaFields = request.fields.filter((field) => field.type === 'image' || field.type === 'video' || field.type === 'audio' || field.type === 'file')
  const parameterFields = request.fields.filter((field) => !mediaFields.includes(field))
  const ui = request.inputUi ?? {}

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

  async function defer() {
    if (!onDefer) return
    setDeferring(true)
    try {
      await onDefer(request.id)
      onSubmitted?.()
    } finally {
      setDeferring(false)
    }
  }

  if (isInteractiveVideo) {
    return (
      <VideoPluginRequestForm
        deferring={deferring}
        mediaFields={mediaFields}
        onDefer={onDefer ? defer : undefined}
        parameterFields={parameterFields}
        resourceLibrary={resourceLibrary}
        request={request}
        setFieldValue={setFieldValue}
        submitting={submitting || deferring}
        submit={submit}
        values={values}
      />
    )
  }

  return (
    <div className="plugin-request-form">
      <div className="plugin-request-head">
        <span className="plugin-request-kicker">{ui.kicker || '交互插件'}</span>
        <strong>{ui.title || request.title}</strong>
        <span>{ui.description || '补充信息和素材后，墨渊会继续处理生成流程。'}</span>
      </div>
      <div className="plugin-request-fields">
        <div className="plugin-request-section">
          <div className="plugin-request-section-title">{ui.settingsSectionTitle || '生成设置'}</div>
          {parameterFields.map((field) => (
            <PluginRequestField field={field} key={field.id} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} />
          ))}
        </div>
        {mediaFields.length ? (
          <div className="plugin-request-section media">
            <div className="plugin-request-section-title">{ui.mediaSectionTitle || '素材输入'}</div>
            <div className="plugin-media-grid">
              {mediaFields.map((field) => (
                <PluginRequestField field={field} key={field.id} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="plugin-request-actions">
        {onDefer ? (
          <button className="plugin-request-cancel" disabled={submitting || deferring} onClick={() => void defer()} type="button">
            {deferring ? '处理中' : '稍后处理'}
          </button>
        ) : null}
        <button className="plugin-request-submit" disabled={submitting || deferring} onClick={() => void submit()} type="button">
          {submitting ? '提交中' : '提交并继续'}
        </button>
      </div>
    </div>
  )
}

function fieldById(fields: PluginInputField[], id: string) {
  return fields.find((field) => field.id === id)
}

function compactFileSummary(values: Record<string, unknown>, field: PluginInputField | undefined) {
  if (!field) return ''
  const count = fileValues(values, field).length
  if (!count) return ''
  return `${count} 个`
}

function VideoPluginRequestForm({
  deferring,
  mediaFields,
  onDefer,
  parameterFields,
  resourceLibrary,
  request,
  setFieldValue,
  submitting,
  submit,
  values,
}: {
  deferring?: boolean
  mediaFields: PluginInputField[]
  onDefer?: () => void | Promise<void>
  parameterFields: PluginInputField[]
  resourceLibrary: PluginResourceLibraryItem[]
  request: RuntimePluginInputRequest
  setFieldValue: (field: PluginInputField, value: unknown) => void
  submitting: boolean
  submit: () => Promise<void>
  values: Record<string, unknown>
}) {
  const ui = request.inputUi ?? {}
  const promptField = fieldById(parameterFields, 'prompt') ?? parameterFields.find((field) => field.type === 'textarea') ?? parameterFields[0]
  const ratioField = fieldById(parameterFields, 'ratio')
  const durationField = fieldById(parameterFields, 'duration')
  const generateAudioField = fieldById(parameterFields, 'generateAudio')
  const returnLastFrameField = fieldById(parameterFields, 'returnLastFrame')
  const watermarkField = fieldById(parameterFields, 'watermark')
  const firstFrameField = fieldById(mediaFields, 'firstFrame')
  const lastFrameField = fieldById(mediaFields, 'lastFrame')
  const referenceImagesField = fieldById(mediaFields, 'referenceImages')
  const referenceVideosField = fieldById(mediaFields, 'referenceVideos')
  const referenceAudiosField = fieldById(mediaFields, 'referenceAudios')
  const otherMediaFields = mediaFields.filter((field) => !['firstFrame', 'lastFrame', 'referenceImages', 'referenceVideos', 'referenceAudios'].includes(field.id))

  return (
    <div className="plugin-request-form video-plugin-form">
      <div className="video-plugin-head">
        <span>{ui.kicker || '视频生成'}</span>
        <strong>{ui.title || request.title || '确认视频需求'}</strong>
        <small>{ui.description || '写下想要的视频，也可以补充参考素材。'}</small>
      </div>

      {promptField ? (
        <label className="video-plugin-prompt">
          <span>{ui.promptSectionTitle || promptField.label || '视频描述'}</span>
          <textarea placeholder={promptField.placeholder} value={fieldValue(values, promptField)} onChange={(event) => setFieldValue(promptField, event.target.value)} />
        </label>
      ) : null}

      <div className="video-plugin-layout">
        <div className="video-plugin-assets">
          <div className="video-plugin-section-title">{ui.mediaSectionTitle || '参考素材'}</div>
          <div className="video-plugin-asset-row">
            {firstFrameField ? <CompactPluginFileField field={firstFrameField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {lastFrameField ? <CompactPluginFileField field={lastFrameField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
          </div>
          <div className="video-plugin-asset-row">
            {referenceImagesField ? <CompactPluginFileField field={referenceImagesField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {referenceVideosField ? <CompactPluginFileField field={referenceVideosField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {referenceAudiosField ? <CompactPluginFileField field={referenceAudiosField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {otherMediaFields.map((field) => <CompactPluginFileField field={field} key={field.id} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} />)}
          </div>
        </div>

        <div className="video-plugin-params">
          <div className="video-plugin-section-title">{ui.settingsSectionTitle || '生成设置'}</div>
          <div className="video-param-grid">
            {ratioField ? <PluginRequestField field={ratioField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {durationField ? <PluginRequestField field={durationField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
          </div>
          <div className="video-toggle-row">
            {generateAudioField ? <PluginRequestField field={generateAudioField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {returnLastFrameField ? <PluginRequestField field={returnLastFrameField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
            {watermarkField ? <PluginRequestField field={watermarkField} resourceLibrary={resourceLibrary} setFieldValue={setFieldValue} values={values} /> : null}
          </div>
          <div className="video-plugin-summary">
            {[firstFrameField, lastFrameField, referenceImagesField, referenceVideosField, referenceAudiosField]
              .map((field) => field ? `${field.label} ${compactFileSummary(values, field) || '未选'}` : '')
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </div>

      <div className="plugin-request-actions">
        {onDefer ? (
          <button className="plugin-request-cancel" disabled={submitting} onClick={() => void onDefer()} type="button">
            {deferring ? '处理中' : '稍后处理'}
          </button>
        ) : null}
        <button className="plugin-request-submit" disabled={submitting} onClick={() => void submit()} type="button">
          {submitting ? '提交中' : '提交并继续'}
        </button>
      </div>
    </div>
  )
}

function CompactPluginFileField({
  field,
  resourceLibrary,
  setFieldValue,
  values,
}: {
  field: PluginInputField
  resourceLibrary: PluginResourceLibraryItem[]
  setFieldValue: (field: PluginInputField, value: unknown) => void
  values: Record<string, unknown>
}) {
  const matchingResources = libraryResourcesForField(resourceLibrary, field)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const files = fileValues(values, field)
  const maxFiles = field.maxFiles ?? 1
  const selectedSummary = files.length ? files.map((file) => file.name ?? fileKindLabel(field)).join('、') : '未选择'
  const canAddMore = files.length < maxFiles
  const availableSlots = Math.max(0, maxFiles - files.length)

  function openLibrary() {
    setLibraryOpen(true)
  }

  function confirmLibrarySelection(resources: PluginResourceLibraryItem[]) {
    setFieldValue(field, mergeFileValues(values, field, resources.map(resourceToFileValue)))
    setLibraryOpen(false)
  }

  function handleLocalFiles(selectedFiles: FileList | null) {
    const nextFiles = Array.from(selectedFiles ?? [])
    if (!nextFiles.length) return
    void Promise.all(nextFiles.map(fileToValue)).then((nextValues) => {
      setFieldValue(field, mergeFileValues(values, field, nextValues))
    })
  }

  return (
    <span className={`compact-file-field ${field.type}`}>
      <span className="compact-file-head">
        <strong title={field.label}>{field.label}</strong>
        {maxFiles > 1 ? <small>{files.length}/{maxFiles}</small> : null}
      </span>
      <span className={`compact-file-summary ${files.length ? 'selected' : ''}`}>
        <span className="compact-file-icon">{files[0] && field.type === 'image' && (files[0].dataUrl || files[0].url) ? <img alt="" src={files[0].dataUrl ?? files[0].url} /> : fileIcon(field)}</span>
        <span>
          <strong>{files.length ? selectedSummary : `添加${fileKindLabel(field)}`}</strong>
          <small>{files.length ? `${files.length}/${maxFiles} 已选` : matchingResources.length ? '从资源库选择，或本地上传' : '从本地上传素材'}</small>
        </span>
        {canAddMore ? (
          <span className="compact-file-summary-actions">
            {matchingResources.length ? <button onClick={openLibrary} type="button">资源库</button> : null}
            <span className="compact-local-action">
              本地
              <input
                accept={field.type === 'image' ? 'image/*' : field.type === 'video' ? 'video/*' : field.type === 'audio' ? 'audio/*' : undefined}
                multiple={maxFiles > 1}
                onChange={(event) => {
                  handleLocalFiles(event.target.files)
                  event.target.value = ''
                }}
                type="file"
              />
            </span>
          </span>
        ) : null}
      </span>
      {libraryOpen && matchingResources.length ? (
        <ResourceLibraryPicker
          availableSlots={availableSlots}
          field={field}
          onClose={() => setLibraryOpen(false)}
          onConfirm={confirmLibrarySelection}
          resources={matchingResources}
        />
      ) : null}
      {files.length ? (
        <span className="compact-file-pills">
          {files.map((file, index) => (
            <button
              key={`${file.name ?? file.url ?? index}-${index}`}
              onClick={() => {
                const next = files.filter((_, fileIndex) => fileIndex !== index)
                setFieldValue(field, maxFiles > 1 ? next : '')
              }}
              title="移除"
              type="button"
            >
              <span>{index + 1}</span>
              <X size={11} />
            </button>
          ))}
        </span>
      ) : null}
    </span>
  )
}

function PluginRequestField({
  field,
  resourceLibrary,
  setFieldValue,
  values,
}: {
  field: PluginInputField
  resourceLibrary: PluginResourceLibraryItem[]
  setFieldValue: (field: PluginInputField, value: unknown) => void
  values: Record<string, unknown>
}) {
  const matchingResources = libraryResourcesForField(resourceLibrary, field)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const files = fileValues(values, field)
  const maxFiles = field.maxFiles ?? 1
  const canAddMore = files.length < maxFiles
  const availableSlots = Math.max(0, maxFiles - files.length)

  function confirmLibrarySelection(resources: PluginResourceLibraryItem[]) {
    setFieldValue(field, mergeFileValues(values, field, resources.map(resourceToFileValue)))
    setLibraryOpen(false)
  }

  return (
    <label className={`plugin-request-field ${field.type}`}>
      <span>{field.label}{field.required ? ' *' : ''}</span>
      {field.type === 'textarea' ? (
        <textarea placeholder={field.placeholder} value={fieldValue(values, field)} onChange={(event) => setFieldValue(field, event.target.value)} />
      ) : field.type === 'select' ? (
        <select value={fieldValue(values, field)} onChange={(event) => setFieldValue(field, event.target.value)}>
          <option value="">请选择</option>
          {field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      ) : field.type === 'boolean' ? (
        <span className="plugin-boolean-field">
          <span className="plugin-boolean-copy">
            <strong>{field.label}</strong>
            {field.helpText ? <small>{field.helpText}</small> : null}
          </span>
          <input checked={Boolean(values[field.id])} onChange={(event) => setFieldValue(field, event.target.checked)} type="checkbox" />
        </span>
      ) : field.type === 'image' || field.type === 'video' || field.type === 'audio' || field.type === 'file' ? (
        <span className="plugin-file-field">
          <span className="plugin-file-source-actions">
            {matchingResources.length ? (
              <button disabled={!canAddMore} onClick={() => setLibraryOpen(true)} type="button">
                <Package size={14} />
                我的资源
              </button>
            ) : null}
            <span className={`plugin-file-inline-upload ${!canAddMore ? 'disabled' : ''}`}>
              <Upload size={14} />
              本地选择
              <input
                accept={field.type === 'image' ? 'image/*' : field.type === 'video' ? 'video/*' : field.type === 'audio' ? 'audio/*' : undefined}
                disabled={!canAddMore}
                multiple={maxFiles > 1}
                onChange={(event) => {
                  const selectedFiles = Array.from(event.target.files ?? [])
                  if (!selectedFiles.length) return
                  void Promise.all(selectedFiles.map(fileToValue)).then((nextValues) => {
                    setFieldValue(field, mergeFileValues(values, field, nextValues))
                    event.target.value = ''
                  })
                }}
                type="file"
              />
            </span>
          </span>
          {libraryOpen && matchingResources.length ? (
            <ResourceLibraryPicker
              availableSlots={availableSlots}
              field={field}
              onClose={() => setLibraryOpen(false)}
              onConfirm={confirmLibrarySelection}
              resources={matchingResources}
            />
          ) : null}
          {!files.length ? (
            <span className="plugin-file-dropzone">
              <span className="plugin-file-icon"><Upload size={18} /></span>
              <span>
                <strong>添加{fileKindLabel(field)}</strong>
                <small>{matchingResources.length ? '从资源库或本地选择素材' : (maxFiles > 1 ? `最多 ${maxFiles} 个` : '选择一个素材')}</small>
              </span>
              <input
                accept={field.type === 'image' ? 'image/*' : field.type === 'video' ? 'video/*' : field.type === 'audio' ? 'audio/*' : undefined}
                disabled={!canAddMore}
                multiple={maxFiles > 1}
                onChange={(event) => {
                  const selectedFiles = Array.from(event.target.files ?? [])
                  if (!selectedFiles.length) return
                  void Promise.all(selectedFiles.map(fileToValue)).then((nextValues) => {
                    setFieldValue(field, mergeFileValues(values, field, nextValues))
                    event.target.value = ''
                  })
                }}
                type="file"
              />
            </span>
          ) : null}
          {files.length ? (
            <span className="plugin-file-list">
              {files.map((file, index) => (
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
                      const next = files.filter((_, fileIndex) => fileIndex !== index)
                      setFieldValue(field, maxFiles > 1 ? next : '')
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
      {field.helpText && field.type !== 'boolean' ? <small className="plugin-request-help">{field.helpText}</small> : null}
    </label>
  )
}

function PluginRequestModal({
  onClose,
  onDefer,
  onSubmit,
  resourceLibrary,
  request,
}: {
  onClose: () => void
  onDefer?: (requestId: string) => void | Promise<void>
  onSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
  resourceLibrary: PluginResourceLibraryItem[]
  request: RuntimePluginInputRequest
}) {
  return (
    <div className="plugin-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="plugin-modal" aria-label={request.title} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <button className="plugin-modal-close" title="关闭" type="button" onClick={onClose}>
          <X size={16} />
        </button>
        <PluginRequestForm onDefer={onDefer} onSubmitted={onClose} onSubmit={onSubmit} resourceLibrary={resourceLibrary} request={request} />
      </section>
    </div>
  )
}

export function TaskProgressCard({
  authToken,
  busyElapsed = 0,
  onPluginDefer,
  onPluginSubmit,
  task,
  tasks,
}: {
  authToken?: string
  busyElapsed?: number
  onPluginDefer?: (requestId: string) => void | Promise<void>
  onPluginSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
  task: CodexTask
  tasks?: CodexTask[]
}) {
  const items = visibleItems(task)
  const plan = task.plan ?? task.turns?.findLast((turn) => turn.plan?.length)?.plan ?? []
  const outputs = task.outputs ?? []
  const approvals = (task.approvals ?? []).filter((approval) => approval.status === 'pending')
  const pluginRequests = (task.pluginRequests ?? []).filter((request) => request.status === 'pending')
  const localResourceLibrary = resourceLibraryFromTasks(tasks ?? [task])
  const [remoteResourceLibrary, setRemoteResourceLibrary] = useState<PluginResourceLibraryItem[]>([])
  const resourceLibrary = mergeResourceLibraries(remoteResourceLibrary, localResourceLibrary)
  const pluginRequestIds = pluginRequests.map((request) => request.id).join('|')
  const [activePluginRequestId, setActivePluginRequestId] = useState<string | null | undefined>(undefined)
  const activePluginRequest = pluginRequests.find((request) => request.id === activePluginRequestId) ?? null
  const sources = task.sources ?? []
  const isLive = task.status === 'queued' || task.status === 'running'
  const statusExplanation = runtimeTaskStatusExplanation(task)
  const hasContent = Boolean(statusExplanation) || plan.length || items.length || outputs.length || approvals.length || pluginRequests.length || sources.length

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

  useEffect(() => {
    if (!authToken || !pluginRequests.length) return
    let cancelled = false
    enterpriseFetch('/me/workspace', authToken, { timeoutMs: 8000 })
      .then((response) => readPayload<UserWorkspaceSummary>(response))
      .then((summary) => {
        if (cancelled) return
        setRemoteResourceLibrary(summary.assets.map(assetToLibraryResource).filter(Boolean) as PluginResourceLibraryItem[])
      })
      .catch((error) => {
        if (cancelled) return
        logClientEvent('plugin.resource_library.load_failed', errorLogDetails(error), 'warn')
      })
    return () => {
      cancelled = true
    }
  }, [authToken, pluginRequestIds])

  if (!hasContent) return null

  return (
    <>
      {activePluginRequest ? (
        <PluginRequestModal
          onClose={() => setActivePluginRequestId(null)}
          onDefer={onPluginDefer}
          onSubmit={onPluginSubmit}
          resourceLibrary={resourceLibrary}
          request={activePluginRequest}
        />
      ) : null}
      <section className="task-progress-card" aria-label="本轮活动">
        <div className="task-progress-heading">本轮活动</div>
      {statusExplanation ? (
        <div className={`task-progress-status ${statusExplanation.kind}`}>
          <span className="task-progress-status-icon">
            {statusExplanation.kind === 'interrupted' ? <X size={14} /> : statusExplanation.kind === 'completed' ? <Check size={14} /> : statusExplanation.kind === 'failed' ? <Circle size={14} /> : <Loader2 className={isLive ? 'task-progress-spin' : undefined} size={14} />}
          </span>
          <span>
            <strong>
              {statusExplanation.title}
              {isLive && busyElapsed ? <small>{formatElapsed(busyElapsed)}</small> : null}
            </strong>
            {statusExplanation.detail ? <em>{statusExplanation.detail}</em> : null}
          </span>
        </div>
      ) : null}
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

      </section>
    </>
  )
}
