import React from 'react'
import { errorLogDetails, logClientEvent } from '../logger'

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

function isBenignResizeObserverError(error: unknown) {
  const message = getErrorMessage(error)
  return (
    message.includes('ResizeObserver loop completed with undelivered notifications') ||
    message.includes('ResizeObserver loop limit exceeded')
  )
}

function isRecoverableReactQueueError(error: unknown) {
  return getErrorMessage(error).includes('Should have a queue. This is likely a bug in React.')
}

function recoverFromReactQueueError(error: unknown) {
  if (!isRecoverableReactQueueError(error)) return false
  const storageKey = 'moyuan.react_queue_error_reload'
  if (window.sessionStorage.getItem(storageKey) === '1') return false
  window.sessionStorage.setItem(storageKey, '1')
  logClientEvent('app.react_queue_recover_reload', errorLogDetails(error), 'warn')
  window.location.reload()
  return true
}

export function renderFatalError(error: unknown) {
  if (isBenignResizeObserverError(error)) {
    logClientEvent('app.resize_observer_notice', errorLogDetails(error), 'warn')
    return
  }
  if (recoverFromReactQueueError(error)) return
  logClientEvent('app.fatal_render_error', errorLogDetails(error), 'error')
  const overlayId = 'moyuan-fatal-error-overlay'
  const existing = document.getElementById(overlayId)
  const overlay = existing ?? document.createElement('div')
  overlay.id = overlayId
  overlay.style.position = 'fixed'
  overlay.style.inset = '0'
  overlay.style.zIndex = '2147483647'
  overlay.style.display = 'grid'
  overlay.style.placeItems = 'center'
  overlay.style.background = '#fbfbf9'
  const message = getErrorMessage(error)
  overlay.replaceChildren(fatalErrorCardElement(message))
  if (!existing) document.body.append(overlay)
}

function fatalErrorCardElement(message: string) {
  const card = document.createElement('section')
  card.style.width = 'min(520px, calc(100vw - 48px))'
  card.style.border = '1px solid #e4e3df'
  card.style.borderRadius = '16px'
  card.style.background = '#fff'
  card.style.padding = '24px'
  card.style.boxShadow = '0 18px 45px rgba(31,35,40,.08)'
  card.style.color = '#202124'
  card.style.fontFamily = "-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC',sans-serif"

  const title = document.createElement('strong')
  title.style.display = 'block'
  title.style.fontSize = '18px'
  title.style.marginBottom = '8px'
  title.textContent = '客户端启动异常'

  const description = document.createElement('p')
  description.style.margin = '0'
  description.style.color = '#626870'
  description.style.lineHeight = '1.7'
  description.textContent = '我已经把错误显示出来，避免白屏。请重启客户端；如果仍然出现，把下面这行发给开发人员。'

  const detail = document.createElement('pre')
  detail.style.margin = '16px 0 0'
  detail.style.whiteSpace = 'pre-wrap'
  detail.style.wordBreak = 'break-word'
  detail.style.borderRadius = '10px'
  detail.style.background = '#f7f7f5'
  detail.style.padding = '12px'
  detail.style.color = '#6e747b'
  detail.textContent = message

  card.append(title, description, detail)
  return card
}

function FatalErrorView({ error }: { error: unknown }) {
  const message = getErrorMessage(error)
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#fbfbf9', color: '#202124', fontFamily: "-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC',sans-serif" }}>
      <section style={{ width: 'min(520px, calc(100vw - 48px))', border: '1px solid #e4e3df', borderRadius: 16, background: '#fff', padding: 24, boxShadow: '0 18px 45px rgba(31,35,40,.08)' }}>
        <strong style={{ display: 'block', fontSize: 18, marginBottom: 8 }}>客户端启动异常</strong>
        <p style={{ margin: 0, color: '#626870', lineHeight: 1.7 }}>我已经把错误显示出来，避免白屏。请重启客户端；如果仍然出现，把下面这行发给开发人员。</p>
        <pre style={{ margin: '16px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderRadius: 10, background: '#f7f7f5', padding: 12, color: '#6e747b' }}>{message}</pre>
      </section>
    </main>
  )
}

export function installGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    const error = event.error ?? event.message
    if (isBenignResizeObserverError(error)) {
      logClientEvent('app.resize_observer_notice', errorLogDetails(error, { filename: event.filename, lineno: event.lineno }), 'warn')
      event.preventDefault()
      return
    }
    if (recoverFromReactQueueError(error)) {
      event.preventDefault()
      return
    }
    logClientEvent('app.window_error', errorLogDetails(event.error ?? event.message, { filename: event.filename, lineno: event.lineno }), 'error')
    renderFatalError(event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    if (isBenignResizeObserverError(event.reason)) {
      logClientEvent('app.resize_observer_notice', errorLogDetails(event.reason), 'warn')
      event.preventDefault()
      return
    }
    if (recoverFromReactQueueError(event.reason)) {
      event.preventDefault()
      return
    }
    logClientEvent('app.unhandled_rejection', errorLogDetails(event.reason), 'error')
    renderFatalError(event.reason)
  })
}

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown) {
    if (isBenignResizeObserverError(error)) {
      logClientEvent('app.resize_observer_notice', errorLogDetails(error), 'warn')
      this.setState({ error: null })
      return
    }
    if (recoverFromReactQueueError(error)) return
    logClientEvent('app.error_boundary', errorLogDetails(error), 'error')
  }

  render() {
    if (this.state.error) return <FatalErrorView error={this.state.error} />
    return this.props.children
  }
}
