import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type RuntimeLogEntry = {
  details?: unknown
  event: string
  level?: LogLevel
  sessionId?: string
  source?: string
  taskId?: string
  timestamp?: string
  workspace?: string
}

const sensitiveKeyPattern =
  /^(token|secret|password|authorization|apiKey|api_key|authCode|auth_code|enterpriseAuthToken|runtimeToken|authToken|accessToken|refreshToken)$/i
const maxStringLength = 1600
const maxArrayItems = 20
const maxObjectKeys = 80

function redactString(value: string) {
  const redacted = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer ***')
    .replace(/(Authorization\s*[:=]\s*)[^\s,;]+/gi, '$1***')
    .replace(/([?&](?:token|runtimeToken|enterpriseAuthToken|apiKey|key)=)[^&\s]+/gi, '$1***')

  return redacted.length > maxStringLength ? `${redacted.slice(0, maxStringLength)}...<truncated>` : redacted
}

function redactValue(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Error) {
    return {
      message: redactString(value.message),
      name: value.name,
      stack: value.stack ? redactString(value.stack) : undefined,
    }
  }
  if (depth > 5) return '[MaxDepth]'
  if (Array.isArray(value)) return value.slice(0, maxArrayItems).map((item) => redactValue(item, depth + 1))
  if (typeof value !== 'object') return String(value)

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, maxObjectKeys)) {
    result[key] = sensitiveKeyPattern.test(key) ? '***' : redactValue(item, depth + 1)
  }
  return result
}

function normalizeLevel(level?: string): LogLevel {
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') return level
  return 'info'
}

function compactLine(entry: RuntimeLogEntry) {
  return `${JSON.stringify({
    ...entry,
    details: redactValue(entry.details),
    level: normalizeLevel(entry.level),
    source: entry.source ?? 'runtime',
    timestamp: entry.timestamp ?? new Date().toISOString(),
  })}\n`
}

export function createRuntimeLogger(runtimeRoot: string) {
  const logDir = path.join(runtimeRoot, 'logs')
  const runtimeLogPath = path.join(logDir, 'runtime.ndjson')
  const clientLogPath = path.join(logDir, 'desktop-client.ndjson')
  let writeQueue = Promise.resolve()

  async function append(entry: RuntimeLogEntry, target: 'runtime' | 'client' = 'runtime') {
    const filePath = target === 'client' ? clientLogPath : runtimeLogPath
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(logDir, { recursive: true })
        await appendFile(filePath, compactLine(entry), 'utf8')
      })
      .catch(() => {
        // Logging must never break user work.
      })
    await writeQueue
  }

  async function recent(target: 'runtime' | 'client' = 'runtime', limit = 200) {
    const filePath = target === 'client' ? clientLogPath : runtimeLogPath
    try {
      const raw = await readFile(filePath, 'utf8')
      return raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-Math.max(1, Math.min(limit, 1000)))
        .map((line) => {
          try {
            return JSON.parse(line) as RuntimeLogEntry
          } catch {
            return { event: 'invalid-log-line', level: 'warn', source: target, details: { line } } satisfies RuntimeLogEntry
          }
        })
    } catch {
      return []
    }
  }

  return {
    append,
    paths: {
      clientLogPath,
      logDir,
      runtimeLogPath,
    },
    recent,
  }
}
