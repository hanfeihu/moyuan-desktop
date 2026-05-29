import { Check, Copy, Download, ExternalLink, Image, Library, RotateCcw, Video } from 'lucide-react'
import type { CodexTask, RuntimeTaskOutput } from '@eaw/shared'
import { runtimeEndpoint } from '../../api'

type ResourceCardItem = {
  createdAt: string
  id: string
  type: 'image' | 'video' | 'file' | 'asset' | 'link' | 'plugin_result'
  title: string
  turnId?: string
  url?: string
  prompt?: string
  model?: string
  usageTokens?: number
}

function resolveResourceUrl(url?: string) {
  if (!url) return undefined
  if (url.startsWith('/api/')) return runtimeEndpoint(url)
  return url
}

function outputToResource(output: RuntimeTaskOutput, turnId?: string): ResourceCardItem | undefined {
  const url = resolveResourceUrl(output.url ?? output.path)
  if (!url && output.type !== 'file') return undefined
  const metadata = output.metadata ?? {}
  return {
    createdAt: output.createdAt,
    id: output.id,
    type: output.type,
    title: output.title,
    turnId: output.turnId ?? turnId,
    url,
    prompt: typeof metadata.prompt === 'string' ? metadata.prompt : undefined,
    model: typeof metadata.model === 'string' ? metadata.model : undefined,
    usageTokens: typeof metadata.usageTokens === 'number' ? metadata.usageTokens : undefined,
  }
}

export function taskResources(task: CodexTask) {
  const resources: ResourceCardItem[] = []
  const itemTurnIds = new Map((task.items ?? []).map((item) => [item.id, item.turnId]))
  for (const output of task.outputs ?? []) {
    const resource = outputToResource(output, output.taskItemId ? itemTurnIds.get(output.taskItemId) : undefined)
    if (resource) resources.push(resource)
  }
  for (const image of task.generatedImages ?? []) {
    resources.push({
      createdAt: image.createdAt,
      id: `generated-image-${image.id}`,
      type: 'image',
      title: '生成图片',
      url: resolveResourceUrl(image.url),
      prompt: image.prompt,
      model: image.model,
      usageTokens: image.usageTokens,
    })
  }
  for (const video of task.generatedVideos ?? []) {
    resources.push({
      createdAt: video.createdAt,
      id: `generated-video-${video.id}`,
      type: 'video',
      title: '生成视频',
      url: resolveResourceUrl(video.url),
      prompt: video.prompt,
      model: video.model,
      usageTokens: video.usageTokens,
    })
  }

  const seen = new Set<string>()
  return resources.filter((resource) => {
    const key = resource.url ?? resource.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime())
}

export function resourceTurnIds(task: CodexTask) {
  return new Set(taskResources(task).map((resource) => resource.turnId).filter(Boolean) as string[])
}

function resourceIcon(type: ResourceCardItem['type']) {
  if (type === 'video') return <Video size={15} />
  if (type === 'image') return <Image size={15} />
  return <ExternalLink size={15} />
}

function resourceTypeText(type: ResourceCardItem['type']) {
  if (type === 'video') return '视频资源'
  if (type === 'image') return '图片资源'
  if (type === 'file') return '文件资源'
  return '资源'
}

export function ResourceCards({
  copiedId,
  onRegenerate,
  onCopy,
  task,
  turnId,
  unanchored = false,
}: {
  copiedId?: string
  onRegenerate?: (prompt: string) => void
  onCopy?: (resource: { id: string; url?: string }) => void
  task: CodexTask
  turnId?: string
  unanchored?: boolean
}) {
  const resources = taskResources(task).filter((resource) => (unanchored ? !resource.turnId : turnId ? resource.turnId === turnId : true))
  if (!resources.length) return null

  return (
    <section className="resource-gallery" aria-label="任务资源">
      <div className="resource-gallery-title">资源交付</div>
      <div className="resource-card-list">
        {resources.slice(0, 6).map((resource) => (
          <article className={`resource-card ${resource.type}`} key={resource.id}>
            <div className="resource-preview">
              {resource.type === 'video' && resource.url ? (
                <video controls preload="metadata" src={resource.url} />
              ) : resource.type === 'image' && resource.url ? (
                <button aria-label="打开图片" onClick={() => window.open(resource.url, '_blank', 'noopener,noreferrer')} type="button">
                  <img alt={resource.title} src={resource.url} />
                </button>
              ) : (
                <div className="resource-file-preview">{resourceIcon(resource.type)}</div>
              )}
            </div>
            <div className="resource-card-body">
              <div className="resource-card-heading">
                <span className="resource-kind">{resourceIcon(resource.type)}{resourceTypeText(resource.type)}</span>
                <strong>{resource.title}</strong>
              </div>
              <div className="resource-meta">
                {resource.model ? <span>{resource.model}</span> : null}
                {resource.usageTokens ? <span>{resource.usageTokens.toLocaleString()} tokens</span> : <span>Token 待结算</span>}
              </div>
              <div className="resource-actions">
                {resource.url ? (
                  <a href={resource.url} download rel="noreferrer" target="_blank" title="下载">
                    <Download size={15} />
                  </a>
                ) : null}
                {resource.url ? (
                  <button onClick={() => onCopy?.(resource)} title="复制链接" type="button">
                    {copiedId === resource.id ? <Check size={15} /> : <Copy size={15} />}
                  </button>
                ) : null}
                <button disabled={!resource.prompt || !onRegenerate} onClick={() => resource.prompt && onRegenerate?.(resource.prompt)} title="重新生成" type="button">
                  <RotateCcw size={15} />
                </button>
                <button disabled title="加入资料库" type="button">
                  <Library size={15} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
