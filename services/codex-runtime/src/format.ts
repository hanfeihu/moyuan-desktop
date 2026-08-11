// Pure formatting / classification helpers for the runtime. No module state —
// depend only on arguments and shared utilities.
import {
  friendlyRuntimeMessage,
  isRuntimeFailureNotice,
  runtimeFailureDiagnostic,
  type CodexTask,
} from '@eaw/shared'

export function redactRequestUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl, 'http://moyuan.local')
    if (url.searchParams.has('token')) url.searchParams.set('token', '***')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return rawUrl.replace(/([?&]token=)[^&]+/g, '$1***')
  }
}

export function requestLogSerializer(request: {
  method?: string
  url?: string
  host?: string
  hostname?: string
  remoteAddress?: string
  remotePort?: number
}) {
  return {
    method: request.method,
    url: redactRequestUrl(request.url),
    host: request.host ?? request.hostname,
    remoteAddress: request.remoteAddress,
    remotePort: request.remotePort,
  }
}

export function previewLogContent(content: string, maxLength = 240) {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength)}...`
}

export function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  const headLength = Math.floor(maxLength * 0.65)
  const tailLength = Math.max(0, maxLength - headLength - 80)
  return `${value.slice(0, headLength)}\n\n... 输出过长，已截断 ${value.length - headLength - tailLength} 个字符 ...\n\n${value.slice(-tailLength)}`
}

export function isRuntimeFailureContent(content: string) {
  const text = content.trim()
  if (!text || text.startsWith('$ ')) return false
  return isRuntimeFailureNotice(text)
}

export function userVisibleFailureMessage(message: string) {
  return friendlyRuntimeMessage(runtimeFailureDiagnostic(message))
}

export function taskUpdatedAtMs(task: CodexTask) {
  return new Date(task.updatedAt ?? task.createdAt ?? 0).getTime()
}
