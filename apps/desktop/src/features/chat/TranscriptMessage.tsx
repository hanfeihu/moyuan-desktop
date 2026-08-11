import { Bot, Circle } from 'lucide-react'
import type { TranscriptItem } from '../../tasks'
import { attachmentHistoryPreviewUrl } from './attachments'
import { MarkdownText } from './markdown'
import { isCommandToolContent, ToolOutput } from './ToolOutput'

export function TranscriptMessage({ item, label, streaming }: { item: TranscriptItem; label: string; streaming: boolean }) {
  const isToolStatus = item.role === 'tool' && !isCommandToolContent(item.content)
  const effectiveLabel = isToolStatus ? '状态' : label

  return (
    <article className={`message ${item.role} ${isToolStatus ? 'tool-status' : ''}`}>
      <div className="message-label" aria-label={effectiveLabel} title={effectiveLabel}>
        {item.role === 'assistant' ? (
          <Bot size={17} />
        ) : item.role === 'tool' ? (
          isToolStatus ? (
            <span className="tool-status-dot" />
          ) : (
            <span className="tool-command-dot" />
          )
        ) : item.role === 'system' ? (
          <Circle size={13} />
        ) : (
          '你'
        )}
      </div>
      <div className="message-body">
        {item.role === 'user' && item.attachments?.length ? (
          <div className="message-attachments">
            {item.attachments.map((attachment) => {
              const previewUrl = attachmentHistoryPreviewUrl(attachment)
              return (
                <button className="message-attachment" key={attachment.id} onClick={() => previewUrl && window.open(previewUrl, '_blank', 'noopener,noreferrer')} type="button">
                  {previewUrl ? <img alt={attachment.name} src={previewUrl} /> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        {item.role === 'assistant' ? <MarkdownText content={item.content} /> : item.role === 'tool' ? <ToolOutput content={item.content} /> : item.content}
        {streaming && item.role === 'assistant' ? <span className="stream-caret" /> : null}
      </div>
    </article>
  )
}
