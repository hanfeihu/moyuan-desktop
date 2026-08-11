import type { CodexTask } from '@eaw/shared'
import { taskResources } from './ResourceCards'
import { attachmentHistoryPreviewUrl } from './attachments'

export type ConversationImage = {
  id: string
  label: string
  name: string
  url: string
  dataUrl?: string
  mimeType?: string
  sha256?: string
  size?: number
  kind: 'generated' | 'uploaded'
  createdAt: string
}

function uniqueLabel(base: string, used: Set<string>) {
  const trimmed = base.trim() || '图片'
  if (!used.has(trimmed)) {
    used.add(trimmed)
    return trimmed
  }
  let index = 2
  while (used.has(`${trimmed}${index}`)) index += 1
  const label = `${trimmed}${index}`
  used.add(label)
  return label
}

function fileBaseName(name: string) {
  return name.replace(/\.[^./\\]+$/, '').trim()
}

export function conversationImages(task: CodexTask): ConversationImage[] {
  const images: ConversationImage[] = []
  const seen = new Set<string>()
  const usedLabels = new Set<string>()

  for (const resource of taskResources(task)) {
    if (resource.type !== 'image' || !resource.url) continue
    if (seen.has(resource.url)) continue
    seen.add(resource.url)
    images.push({
      id: resource.id,
      label: uniqueLabel(resource.title || '生成图片', usedLabels),
      name: resource.title || '生成图片',
      url: resource.url,
      kind: 'generated',
      createdAt: resource.createdAt,
    })
  }

  for (const message of task.transcript ?? []) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== 'image') continue
      const previewUrl = attachmentHistoryPreviewUrl(attachment)
      const dedupeKey = attachment.storageUrl ?? attachment.dataUrl ?? previewUrl ?? attachment.id
      if (!previewUrl || seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      images.push({
        id: attachment.id,
        label: uniqueLabel(fileBaseName(attachment.name) || '图片', usedLabels),
        name: attachment.name,
        url: previewUrl,
        dataUrl: attachment.dataUrl,
        mimeType: attachment.mimeType,
        sha256: attachment.sha256,
        size: attachment.size,
        kind: 'uploaded',
        createdAt: attachment.createdAt,
      })
    }
  }

  return images.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}
