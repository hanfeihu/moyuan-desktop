import { Bot } from 'lucide-react'
import { Fragment, type RefObject } from 'react'
import type { CodexTask } from '@eaw/shared'
import { messageLabel, type TranscriptItem } from '../../tasks'
import { formatElapsed } from '../../utils/format'
import { ResourceCards, resourceTurnIds, taskResources } from './ResourceCards'
import { TranscriptMessage } from './TranscriptMessage'

function pendingStatusLabel(busyElapsed: number) {
  return `正在处理 ${formatElapsed(busyElapsed)}`
}

function latestResourceCreatedAt(task: CodexTask) {
  const timestamps = taskResources(task)
    .filter((resource) => !resource.turnId)
    .map((resource) => resource.createdAt)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value))
  return timestamps.length ? Math.max(...timestamps) : undefined
}

function unanchoredResourceInsertIndex(task: CodexTask, visibleTranscript: TranscriptItem[]) {
  const resourceNoticeIndex = visibleTranscript.findLastIndex((item) => item.role === 'assistant' && item.content.includes('已整理为资源卡'))
  if (resourceNoticeIndex >= 0) return resourceNoticeIndex + 1

  const resourceTime = latestResourceCreatedAt(task)
  if (!resourceTime) return visibleTranscript.length
  const laterUserIndex = visibleTranscript.findIndex((item) => item.role === 'user' && new Date(item.timestamp).getTime() > resourceTime)
  return laterUserIndex >= 0 ? laterUserIndex : visibleTranscript.length
}

export function Transcript({
  activeTask,
  busyElapsed,
  isWelcome,
  onRegenerateResource,
  shouldShowThinking,
  transcriptBottomRef,
  transcriptRef,
  visibleTranscript,
}: {
  activeTask: CodexTask
  busyElapsed: number
  isWelcome: boolean
  onRegenerateResource?: (prompt: string) => void
  shouldShowThinking: boolean
  transcriptBottomRef: RefObject<HTMLDivElement>
  transcriptRef: RefObject<HTMLDivElement>
  visibleTranscript: TranscriptItem[]
}) {
  const insertUnanchoredResourceAt = unanchoredResourceInsertIndex(activeTask, visibleTranscript)
  const anchoredResourceTurnIds = resourceTurnIds(activeTask)
  const lastVisibleIndexByTurn = new Map<string, number>()
  visibleTranscript.forEach((item, index) => {
    if (item.turnId) lastVisibleIndexByTurn.set(item.turnId, index)
  })

  async function copyResourceUrl(resource: { id: string; url?: string }) {
    if (!resource.url) return
    await navigator.clipboard.writeText(resource.url)
  }

  const resourceCardProps = {
    onCopy: copyResourceUrl,
    onRegenerate: onRegenerateResource,
    task: activeTask,
  }

  return (
    <div className={`transcript ${isWelcome ? 'welcome' : ''}`} ref={transcriptRef}>
      {visibleTranscript.map((item, index) => {
        const isLatestAssistant = item.role === 'assistant' && index === visibleTranscript.length - 1 && activeTask.status === 'running'
        const itemKey = `${activeTask.id}-${[item.turnId, item.eventId, item.itemId, item.seq, index, item.role].filter(Boolean).join('-')}`
        const shouldRenderTurnResources = Boolean(item.turnId && anchoredResourceTurnIds.has(item.turnId) && lastVisibleIndexByTurn.get(item.turnId) === index)
        return (
          <Fragment key={itemKey}>
            {index === 0 && insertUnanchoredResourceAt === 0 ? <ResourceCards {...resourceCardProps} unanchored /> : null}
            <TranscriptMessage item={item} label={messageLabel(item.role)} streaming={isLatestAssistant} />
            {shouldRenderTurnResources ? <ResourceCards {...resourceCardProps} turnId={item.turnId} /> : null}
            {index + 1 === insertUnanchoredResourceAt ? <ResourceCards {...resourceCardProps} unanchored /> : null}
          </Fragment>
        )
      })}
      {insertUnanchoredResourceAt === visibleTranscript.length ? <ResourceCards {...resourceCardProps} unanchored /> : null}
      {shouldShowThinking && (
        <article className="message assistant pending">
          <div className="message-label">
            <Bot size={17} />
          </div>
          <div className="message-body">
            <span className="typing-dot" />
            <span className="thinking-copy">{pendingStatusLabel(busyElapsed)}</span>
          </div>
        </article>
      )}
      <div className="transcript-bottom" ref={transcriptBottomRef} />
    </div>
  )
}
