// Pure helpers for parsing upstream skill-provider payloads (image / video
// generation responses). No module state — safe to unit test in isolation.

export function findFirstString(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstString(item, keys)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  for (const value of Object.values(record)) {
    const found = findFirstString(value, keys)
    if (found) return found
  }
  return undefined
}

export function findFirstVideoUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstVideoUrl(item)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string' && /^https?:\/\//i.test(value) && (/\.(mp4|webm|mov)(\?|#|$)/i.test(value) || /video/i.test(key))) {
      return value
    }
  }
  for (const value of Object.values(record)) {
    const found = findFirstVideoUrl(value)
    if (found) return found
  }
  return undefined
}

function isImageUrl(value: string) {
  return /^https?:\/\//i.test(value) && /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(value)
}

export function findFirstLastFrameUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstLastFrameUrl(item)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replace(/[-_\s]+/g, '')
    const looksLikeLastFrame = normalizedKey.includes('lastframe') || normalizedKey.includes('tailframe') || normalizedKey.includes('endframe')
    if (typeof value === 'string' && looksLikeLastFrame && isImageUrl(value)) return value
    if (looksLikeLastFrame && value && typeof value === 'object') {
      const nested = findFirstString(value, ['url', 'image_url', 'imageUrl'])
      if (nested && isImageUrl(nested)) return nested
    }
  }
  for (const value of Object.values(record)) {
    const found = findFirstLastFrameUrl(value)
    if (found) return found
  }
  return undefined
}

export async function readUpstreamJson(response: Response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text }
  }
}

export function usageTotalTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return undefined
  const total = (usage as { total_tokens?: unknown; totalTokens?: unknown }).total_tokens ?? (usage as { total_tokens?: unknown; totalTokens?: unknown }).totalTokens
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? Math.ceil(total) : undefined
}

export function normalizedVideoStatus(status?: string) {
  const value = (status ?? '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'done', 'finish', 'finished'].some((item) => value.includes(item))) return 'completed'
  if (['failed', 'error', 'canceled', 'cancelled', 'rejected'].some((item) => value.includes(item))) return 'failed'
  return 'running'
}

export function firstImageFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const data = (payload as { data?: unknown }).data
  return Array.isArray(data) && data[0] && typeof data[0] === 'object' ? (data[0] as { b64_json?: unknown; url?: unknown }) : undefined
}

export function promptFromVideoContent(content: unknown) {
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const text = (item as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return ''
}
