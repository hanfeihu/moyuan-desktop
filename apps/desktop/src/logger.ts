import { enterpriseFetch, runtimeFetch } from './api'
import { authTokenStorageKey, desktopAppVersion, desktopPlatform } from './config'

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

type ClientLogPayload = {
  appVersion: string
  deviceId: string
  details?: unknown
  event: string
  level: ClientLogLevel
  platform: string
  source: 'desktop-renderer'
  timestamp: string
  userAgent: string
}

const deviceIdStorageKey = 'moyuan.device.id'

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

function stableDeviceId() {
  const existing = window.localStorage.getItem(deviceIdStorageKey)
  if (existing) return existing
  const id = window.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(16).slice(2)}`
  window.localStorage.setItem(deviceIdStorageKey, id)
  return id
}

function enterpriseAuthToken() {
  return window.localStorage.getItem(authTokenStorageKey) ?? ''
}

export function logClientEvent(event: string, details?: unknown, level: ClientLogLevel = 'info') {
  const payload: ClientLogPayload = {
    appVersion: desktopAppVersion,
    deviceId: stableDeviceId(),
    details,
    event,
    level,
    platform: desktopPlatform,
    source: 'desktop-renderer',
    timestamp: new Date().toISOString(),
    userAgent: window.navigator.userAgent,
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

    const token = enterpriseAuthToken()
    if (token) {
      enterpriseFetch('/client-logs', token, {
        body: JSON.stringify(payload),
        method: 'POST',
      }).catch(() => {
        // Remote log collection must never affect the desktop experience.
      })
    }
  }, 0)
}
