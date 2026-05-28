import { ChevronDown, Loader2, Plus, Send, Settings, Square, Zap } from 'lucide-react'
import type { RefObject } from 'react'

export function Composer({
  canSubmit,
  composerRef,
  isBusy,
  isCancelling,
  isSubmitting,
  onPromptChange,
  onStop,
  onSubmit,
  placeholder,
  prompt,
  quotaDepleted,
  quotaNotice,
  textareaRef,
}: {
  canSubmit: boolean
  composerRef: RefObject<HTMLElement>
  isBusy: boolean
  isCancelling: boolean
  isSubmitting: boolean
  onPromptChange: (value: string) => void
  onStop: () => void
  onSubmit: () => void
  placeholder: string
  prompt: string
  quotaDepleted: boolean
  quotaNotice: string
  textareaRef: RefObject<HTMLTextAreaElement>
}) {
  return (
    <footer className={`composer ${prompt.trim() ? 'has-text' : 'is-empty'}`} ref={composerRef}>
      <textarea
        ref={textareaRef}
        rows={1}
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onSubmit()
          }
        }}
        placeholder={placeholder}
      />
      {quotaDepleted || quotaNotice ? (
        <div className="composer-quota-note">
          <Zap size={13} />
          <span>{quotaNotice || '当前账号暂无可用 Token，管理员派发额度后会自动刷新。'}</span>
        </div>
      ) : null}
      <div className="composer-toolbar">
        <div className="composer-tools">
          <button className="composer-icon-button" title="添加上下文" type="button">
            <Plus size={16} />
          </button>
          <button className="composer-soft-button" title="自定义" type="button">
            <Settings size={15} />
            <span>自定义</span>
          </button>
        </div>
        <div className="composer-tools right">
          <button className="composer-model-button" title="模型" type="button">
            <span>gpt-5.5</span>
            <ChevronDown size={14} />
          </button>
          <button className="composer-soft-button compact" title="推理强度" type="button">
            medium
          </button>
          <button
            className={`send-button ${isBusy ? 'stop' : ''}`}
            disabled={isBusy ? isCancelling : !canSubmit}
            onClick={isBusy ? onStop : onSubmit}
            title={isBusy ? '停止本次任务' : quotaDepleted ? '等待后台派发 Token 额度' : '发送'}
            type="button"
          >
            {isBusy ? (isCancelling ? <Loader2 size={16} className="spin" /> : <Square size={13} />) : isSubmitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </footer>
  )
}
