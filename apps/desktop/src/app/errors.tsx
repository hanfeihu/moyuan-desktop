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

export function renderFatalError(error: unknown) {
  if (isBenignResizeObserverError(error)) {
    logClientEvent('app.resize_observer_notice', errorLogDetails(error), 'warn')
    return
  }
  logClientEvent('app.fatal_render_error', errorLogDetails(error), 'error')
  const root = document.getElementById('root')
  if (!root) return
  const message = getErrorMessage(error)
  root.innerHTML = `
    <main style="min-height:100vh;display:grid;place-items:center;background:#fbfbf9;color:#202124;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC',sans-serif">
      <section style="width:min(520px,calc(100vw - 48px));border:1px solid #e4e3df;border-radius:16px;background:#fff;padding:24px;box-shadow:0 18px 45px rgba(31,35,40,.08)">
        <strong style="display:block;font-size:18px;margin-bottom:8px">客户端启动异常</strong>
        <p style="margin:0;color:#626870;line-height:1.7">我已经把错误显示出来，避免白屏。请重启客户端；如果仍然出现，把下面这行发给开发人员。</p>
        <pre style="margin:16px 0 0;white-space:pre-wrap;word-break:break-word;border-radius:10px;background:#f7f7f5;padding:12px;color:#6e747b">${message}</pre>
      </section>
    </main>
  `
}

export function installGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    const error = event.error ?? event.message
    if (isBenignResizeObserverError(error)) {
      logClientEvent('app.resize_observer_notice', errorLogDetails(error, { filename: event.filename, lineno: event.lineno }), 'warn')
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
    logClientEvent('app.error_boundary', errorLogDetails(error), 'error')
    renderFatalError(error)
  }

  render() {
    if (this.state.error) return null
    return this.props.children
  }
}
