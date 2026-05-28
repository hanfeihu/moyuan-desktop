import { runtimeFetch } from './api'

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

type ClientLogPayload = {
  details?: unknown
  event: string
  level: ClientLogLevel
  source: 'desktop-renderer'
  timestamp: string
}

function compactError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}

export function errorLogDetails(error: unknown, extra?: Record<string, unknown>) {
  return {
    ...extra,
    error: compactError(error),
  }
}

export function logClientEvent(event: string, details?: unknown, level: ClientLogLevel = 'info') {
  const payload: ClientLogPayload = {
    details,
    event,
    level,
    source: 'desktop-renderer',
    timestamp: new Date().toISOString(),
  }

  window.setTimeout(() => {
    runtimeFetch('/api/logs/client', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }).catch(() => {
      if (import.meta.env.DEV) {
        console.debug('[moyuan-log]', payload)
      }
    })
  }, 0)
}
