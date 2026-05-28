import { Bot, CheckCircle2, Loader2, Mail, OctagonAlert } from 'lucide-react'
import { useState } from 'react'
import type { AuthMessageTone, AuthMode, AuthValues } from './types'

export function AuthScreen({
  authMode,
  busy,
  message,
  messageTone = 'info',
  onModeChange,
  onSendCode,
  onSubmit,
}: {
  authMode: AuthMode
  busy: boolean
  message: string
  messageTone?: AuthMessageTone
  onModeChange: (mode: AuthMode) => void
  onSendCode: (email: string) => Promise<boolean>
  onSubmit: (values: AuthValues) => Promise<void>
}) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)

  async function sendCode() {
    const sent = await onSendCode(email.trim())
    if (sent) setCodeSent(true)
  }

  function changeEmail(value: string) {
    setEmail(value)
    setCodeSent(false)
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="auth-logo">
            <Bot size={20} />
          </div>
          <div>
            <strong>墨渊</strong>
            <span>企业桌面 AI 工作台</span>
          </div>
        </div>

        <div className="auth-copy">
          <h1>{authMode === 'login' ? '登录企业账号' : '注册企业账号'}</h1>
          <p>使用邮箱验证码进入客户端，企业额度会持续记录并同步到后台。</p>
        </div>

        <div className="auth-tabs">
          <button className={authMode === 'login' ? 'active' : ''} onClick={() => onModeChange('login')} type="button">
            登录
          </button>
          <button className={authMode === 'register' ? 'active' : ''} onClick={() => onModeChange('register')} type="button">
            注册
          </button>
        </div>

        <div className="auth-form">
          {authMode === 'register' ? (
            <label>
              <span>姓名</span>
              <input onChange={(event) => setName(event.target.value)} placeholder="你的名字" value={name} />
            </label>
          ) : null}
          <label>
            <span>邮箱</span>
            <input onChange={(event) => changeEmail(event.target.value)} placeholder="name@example.com" value={email} />
          </label>
          <div className="auth-code-row">
            <label>
              <span>验证码</span>
              <input onChange={(event) => setCode(event.target.value)} placeholder="6 位验证码" value={code} />
            </label>
            <button disabled={busy || !email.trim()} onClick={sendCode} type="button">
              {codeSent ? '重发' : '发送'}
            </button>
          </div>
          {message ? (
            <div className={`auth-message ${messageTone}`}>
              {messageTone === 'success' ? <CheckCircle2 size={14} /> : messageTone === 'error' ? <OctagonAlert size={14} /> : null}
              <span>{message}</span>
            </div>
          ) : null}
          <button className="auth-submit" disabled={busy || !email.trim() || !code.trim()} onClick={() => onSubmit({ code, email, name })} type="button">
            {busy ? <Loader2 className="spin" size={16} /> : <Mail size={16} />}
            {authMode === 'login' ? '登录' : '注册并登录'}
          </button>
        </div>
      </section>
    </main>
  )
}
