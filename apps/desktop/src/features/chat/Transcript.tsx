import { Bot } from 'lucide-react'
import type { RefObject } from 'react'
import type { CodexTask } from '@eaw/shared'
import { messageLabel, type TranscriptItem } from '../../tasks'
import { formatElapsed } from '../../utils/format'
import { TaskProgressCard } from './TaskProgressCard'
import { TranscriptMessage } from './TranscriptMessage'

export function Transcript({
  activeTask,
  busyElapsed,
  isCancelling,
  isWelcome,
  onPluginSubmit,
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
  onPluginSubmit: (requestId: string, values: Record<string, unknown>) => void | Promise<void>
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
      <TaskProgressCard onPluginSubmit={onPluginSubmit} task={activeTask} />
      {shouldShowThinking && (
        <article className="message assistant pending">
          <div className="message-label">
            <Bot size={17} />
          </div>
          <div className="message-body">
            <span className="typing-dot" />
            <span className="thinking-copy">思考中 {formatElapsed(busyElapsed)}</span>
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
