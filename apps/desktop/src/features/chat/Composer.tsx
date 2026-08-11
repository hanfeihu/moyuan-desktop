import { ChevronDown, Clapperboard, Image as ImageIcon, Loader2, Plus, Send, Settings, Square, X, Zap } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { RuntimeAttachment } from '@eaw/shared'
import type { ExecutionSettings } from '../../config'
import { attachmentDraftPreviewUrl } from './attachments'
import type { ConversationImage } from './conversationImages'

const reasoningLabel: Record<ExecutionSettings['reasoningEffort'], string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
}

const sandboxLabel: Record<ExecutionSettings['sandboxMode'], string> = {
  'danger-full-access': '全权限',
  'read-only': '只读',
  'workspace-write': '工作区',
}

type MentionState = {
  start: number
  end: number
  query: string
}

const MENTION_LIMIT = 8

function detectMention(value: string, caret: number): MentionState | null {
  let index = caret - 1
  while (index >= 0) {
    const char = value[index]
    if (char === '@') {
      const before = index > 0 ? value[index - 1] : ''
      if (index === 0 || /\s/.test(before)) {
        const query = value.slice(index + 1, caret)
        if (/\s/.test(query)) return null
        return { start: index, end: caret, query }
      }
      return null
    }
    if (/\s/.test(char)) return null
    index -= 1
  }
  return null
}

export function Composer({
  attachments = [],
  canSubmit,
  composerRef,
  executionSettings,
  isBusy,
  isCancelling,
  isSubmitting,
  mentionImages = [],
  onMentionSelect,
  onPromptChange,
  onRemoveAttachment,
  onSelectImages,
  onReasoningToggle,
  onSandboxToggle,
  onStop,
  onSubmit,
  onToggleStoryboard,
  placeholder,
  prompt = '',
  quotaDepleted,
  quotaNotice,
  storyboardMode = false,
  textareaRef,
}: {
  attachments?: RuntimeAttachment[]
  canSubmit: boolean
  composerRef: RefObject<HTMLElement>
  executionSettings: ExecutionSettings
  isBusy: boolean
  isCancelling: boolean
  isSubmitting: boolean
  mentionImages?: ConversationImage[]
  onMentionSelect: (image: ConversationImage) => void
  onPromptChange: (value: string) => void
  onRemoveAttachment: (id: string) => void
  onSelectImages: (files: File[]) => void
  onReasoningToggle: () => void
  onSandboxToggle: () => void
  onStop: () => void
  onSubmit: () => void
  onToggleStoryboard: () => void
  placeholder: string
  prompt: string
  quotaDepleted: boolean
  quotaNotice: string
  storyboardMode?: boolean
  textareaRef: RefObject<HTMLTextAreaElement>
}) {
  const hasDraftContent = Boolean(prompt.trim()) || attachments.length > 0
  const [mention, setMention] = useState<MentionState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const mentionListRef = useRef<HTMLDivElement | null>(null)

  const matches = useMemo(() => {
    if (!mention) return []
    const query = mention.query.trim().toLowerCase()
    const filtered = query
      ? mentionImages.filter((image) => image.label.toLowerCase().includes(query) || image.name.toLowerCase().includes(query))
      : mentionImages
    return filtered.slice(0, MENTION_LIMIT)
  }, [mention, mentionImages])

  const mentionOpen = Boolean(mention)
  const hasMatches = matches.length > 0

  useEffect(() => {
    setActiveIndex(0)
  }, [mention?.start, mention?.query])

  useEffect(() => {
    if (activeIndex >= matches.length) setActiveIndex(0)
  }, [activeIndex, matches.length])

  function closeMention() {
    setMention(null)
  }

  function syncMention() {
    const element = textareaRef.current
    if (!element) return
    if (element.selectionStart !== element.selectionEnd) {
      setMention(null)
      return
    }
    setMention(detectMention(element.value, element.selectionStart))
  }

  function handleChange(value: string) {
    onPromptChange(value)
    const element = textareaRef.current
    const caret = element ? element.selectionStart : value.length
    setMention(detectMention(value, caret))
  }

  function selectMention(image: ConversationImage) {
    if (!mention) return
    const before = prompt.slice(0, mention.start)
    const after = prompt.slice(mention.end)
    const token = `@${image.label}`
    const needsSpace = !after.startsWith(' ')
    const nextValue = `${before}${token}${needsSpace ? ' ' : ''}${after}`
    const caret = before.length + token.length + (needsSpace ? 1 : 0)
    onPromptChange(nextValue)
    onMentionSelect(image)
    setMention(null)
    window.requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.setSelectionRange(caret, caret)
    })
  }

  function handleFiles(files: FileList | File[]) {
    const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (images.length) onSelectImages(images)
  }

  return (
    <footer
      className={`composer ${hasDraftContent ? 'has-text' : 'is-empty'}`}
      onDragOver={(event) => {
        if (isBusy) return
        event.preventDefault()
      }}
      onDrop={(event) => {
        if (isBusy) return
        event.preventDefault()
        handleFiles(event.dataTransfer.files)
      }}
      ref={composerRef}
    >
      {mentionOpen ? (
        <div className="mention-popover" ref={mentionListRef} role="listbox" aria-label="引用对话图片">
          <div className="mention-popover-head">
            <ImageIcon size={13} />
            <span>引用图片{mention?.query ? `：${mention.query}` : ''}</span>
          </div>
          {hasMatches ? (
            <div className="mention-popover-grid">
              {matches.map((image, index) => (
                <button
                  className={`mention-popover-item ${index === activeIndex ? 'active' : ''}`}
                  key={image.id}
                  onClick={() => selectMention(image)}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  title={image.label}
                  type="button"
                >
                  <span className="mention-popover-thumb">
                    <img alt="" src={image.url} />
                  </span>
                  <span className="mention-popover-label">{image.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mention-popover-empty">
              {mentionImages.length === 0 ? '当前对话还没有图片，先生成或上传一张图片后即可引用。' : '没有匹配的图片。'}
            </div>
          )}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span className="composer-attachment" key={attachment.id}>
              <img alt={attachment.name} src={attachmentDraftPreviewUrl(attachment)} />
              <button aria-label={`移除 ${attachment.name}`} onClick={() => onRemoveAttachment(attachment.id)} type="button">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        rows={1}
        value={prompt}
        onChange={(event) => handleChange(event.target.value)}
        onClick={syncMention}
        onSelect={syncMention}
        onBlur={() => window.setTimeout(closeMention, 120)}
        onPaste={(event) => {
          if (isBusy) return
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'))
          if (files.length) {
            event.preventDefault()
            onSelectImages(files)
          }
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            return
          }
          if (mentionOpen && hasMatches) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((current) => (current + 1) % matches.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((current) => (current - 1 + matches.length) % matches.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              selectMention(matches[activeIndex])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              closeMention()
              return
            }
          }
          if (mentionOpen && event.key === 'Escape') {
            event.preventDefault()
            closeMention()
            return
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder={storyboardMode ? '分镜模式：粘贴一段短剧剧本并发送，AI 会自动拆成分镜卡' : placeholder}
      />
      {quotaDepleted || quotaNotice ? (
        <div className="composer-quota-note">
          <Zap size={13} />
          <span>{quotaNotice || '当前账号暂无可用 Token，可点击右上角额度入口充值或联系管理员增加额度。'}</span>
        </div>
      ) : null}
      <div className="composer-toolbar">
        <div className="composer-tools">
          <label className="composer-icon-button" title="添加图片">
            <Plus size={16} />
            <input
              className="composer-file-input"
              accept="image/*"
              multiple
              onChange={(event) => {
                handleFiles(event.target.files ?? [])
                event.currentTarget.value = ''
              }}
              type="file"
            />
          </label>
          <button className="composer-soft-button" title="自定义" type="button">
            <Settings size={15} />
            <span>本机</span>
          </button>
          <button
            className={`composer-soft-button storyboard-toggle ${storyboardMode ? 'active' : ''}`}
            title="分镜模式：发送剧本自动拆分镜"
            type="button"
            onClick={onToggleStoryboard}
          >
            <Clapperboard size={15} />
            <span>分镜</span>
          </button>
        </div>
        <div className="composer-tools right">
          <button className="composer-model-button" title="模型" type="button">
            <span>gpt-5.5</span>
            <ChevronDown size={14} />
          </button>
          <button className="composer-soft-button compact" title="推理强度在本机保存，点击切换" type="button" onClick={onReasoningToggle}>
            {reasoningLabel[executionSettings.reasoningEffort]}
          </button>
          <button className="composer-soft-button compact permission" title="本机执行权限在本机保存，点击切换" type="button" onClick={onSandboxToggle}>
            {sandboxLabel[executionSettings.sandboxMode]}
          </button>
          <button
            className={`send-button ${isBusy ? 'stop' : ''}`}
            disabled={isBusy ? isCancelling : !canSubmit}
            onClick={isBusy ? onStop : onSubmit}
            title={isBusy ? '停止生成' : quotaDepleted ? 'Token 额度不足' : '发送'}
            type="button"
          >
            {isBusy ? (isCancelling ? <Loader2 size={16} className="spin" /> : <Square size={13} />) : isSubmitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </footer>
  )
}
