import { Bot } from 'lucide-react'
import type { RefObject } from 'react'
import type { CodexTask } from '@eaw/shared'
import { messageLabel, type TranscriptItem } from '../../tasks'
import { formatElapsed } from '../../utils/format'
import { TranscriptMessage } from './TranscriptMessage'

function pendingStatusLabel(task: CodexTask, visibleTranscript: TranscriptItem[], busyElapsed: number) {
  const elapsed = formatElapsed(busyElapsed)
  const latestVisible = visibleTranscript.at(-1)
  if (task.status === 'queued') return `已发送，等待本地 Runtime 接手 ${elapsed}`
  if (latestVisible?.role === 'tool') return `正在执行工具 ${elapsed}`
  if (latestVisible?.role === 'system') return `正在推进任务 ${elapsed}`
  if (busyElapsed < 2500) return `已发送，正在启动本轮任务 ${elapsed}`
  if (busyElapsed < 9000) return `Codex 正在理解并编排 ${elapsed}`
  return `仍在编排，可能正在准备工具调用 ${elapsed}`
}

export function Transcript({
  activeTask,
  busyElapsed,
  isCancelling,
  isWelcome,
  onStop,
  shouldShowThinking,
  transcriptBottomRef,
  transcriptRef,
  visibleTranscript,
}: {
  activeTask: CodexTask
  busyElapsed: number
  isCancelling: boolean
  isWelcome: boolean
  onStop: () => void
  shouldShowThinking: boolean
  transcriptBottomRef: RefObject<HTMLDivElement>
  transcriptRef: RefObject<HTMLDivElement>
  visibleTranscript: TranscriptItem[]
}) {
  return (
    <div className={`transcript ${isWelcome ? 'welcome' : ''}`} ref={transcriptRef}>
      {visibleTranscript.map((item, index) => {
        const isLatestAssistant = item.role === 'assistant' && index === visibleTranscript.length - 1 && activeTask.status === 'running'
        return <TranscriptMessage item={item} key={`${activeTask.id}-${item.itemId ?? `${index}-${item.role}`}`} label={messageLabel(item.role)} streaming={isLatestAssistant} />
      })}
      {shouldShowThinking && (
        <article className="message assistant pending">
          <div className="message-label">
            <Bot size={17} />
          </div>
          <div className="message-body">
            <span className="typing-dot" />
            <span className="thinking-copy">{pendingStatusLabel(activeTask, visibleTranscript, busyElapsed)}</span>
            <button className="inline-stop-button" disabled={isCancelling} onClick={onStop} type="button">
              {isCancelling ? '停止中' : '停止'}
            </button>
          </div>
        </article>
      )}
      <div className="transcript-bottom" ref={transcriptBottomRef} />
    </div>
  )
}
