import { enterpriseFetch } from './api'
import { authTokenStorageKey, desktopAppVersion, desktopPlatform } from './config'
import { errorLogDetails, logClientEvent, stableDeviceId } from './logger'

const diagnosticsUploadKey = 'moyuan.diagnostics.lastUploadAt'
const diagnosticsUploadIntervalMs = 2 * 60 * 1000

function enterpriseAuthToken() {
  return window.localStorage.getItem(authTokenStorageKey) ?? ''
}

function shouldUploadDiagnostics(reason: string) {
  if (reason === 'manual') return true
  const lastUploadAt = Number(window.sessionStorage.getItem(diagnosticsUploadKey) ?? 0)
  return !lastUploadAt || Date.now() - lastUploadAt > diagnosticsUploadIntervalMs
}

export async function uploadDiagnosticsSnapshot(reason = 'automatic') {
  const token = enterpriseAuthToken()
  const collector = window.moyuanDesktop?.collectDiagnostics
  if (!token || !collector || !shouldUploadDiagnostics(reason)) return false

  try {
    const snapshot = await collector()
    await enterpriseFetch('/client-logs', token, {
      body: JSON.stringify({
        appVersion: desktopAppVersion,
        deviceId: stableDeviceId(),
        details: {
          reason,
          snapshot,
        },
        event: 'desktop.diagnostics.snapshot',
        level: snapshot.runtime.alive ? 'info' : 'warn',
        platform: desktopPlatform,
        source: 'desktop-diagnostics',
        timestamp: new Date().toISOString(),
        userAgent: window.navigator.userAgent,
      }),
      method: 'POST',
      timeoutMs: 12000,
    })
    window.sessionStorage.setItem(diagnosticsUploadKey, String(Date.now()))
    logClientEvent('desktop.diagnostics.uploaded', {
      reason,
      runtimeAlive: snapshot.runtime.alive,
    }, snapshot.runtime.alive ? 'debug' : 'warn')
    return true
  } catch (error) {
    logClientEvent('desktop.diagnostics.upload_failed', errorLogDetails(error, { reason }), 'warn')
    return false
  }
}
