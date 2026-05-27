import cors from '@fastify/cors'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import { defaultEnterpriseApiBase as enterpriseApiBase, getImageConfig, getModelConfig } from './config.js'
import { loadEnterpriseSkillSet, validateEnterpriseQuota } from './enterprise/client.js'
import { buildSkillInstructionBlock, isLikelyToolCallFragment, isMoyuanToolCallContent, parseMoyuanToolCall } from './skills/contracts.js'
import type { RuntimeRunOptions } from './skills/contracts.js'
import { runImageGenerationTool, runMoyuanToolCall } from './skills/executor.js'
import type { TaskRecord } from './tasks/types.js'

function redactRequestUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl, 'http://moyuan.local')
    if (url.searchParams.has('token')) url.searchParams.set('token', '***')
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return rawUrl.replace(/([?&]token=)[^&]+/g, '$1***')
  }
}

function requestLogSerializer(request: {
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

const app = Fastify({
  logger: {
    serializers: {
      req: requestLogSerializer,
    },
    redact: ['req.headers.authorization', 'req.headers.x-moyuan-runtime-token'],
  },
})
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const runtimeToken = process.env.MOYUAN_RUNTIME_TOKEN ?? ''
const runtimeHost = process.env.CODEX_RUNTIME_HOST ?? '127.0.0.1'

await app.register(cors, {
  origin(origin, callback) {
    const allowed =
      !origin ||
      origin === 'null' ||
      /^file:\/\//.test(origin) ||
      /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
    callback(null, allowed)
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'x-moyuan-runtime-token'],
  methods: ['GET', 'POST', 'OPTIONS'],
})

app.addHook('onRequest', async (request, reply) => {
  if (!runtimeToken || request.method === 'OPTIONS') return
  const queryToken =
    request.query && typeof request.query === 'object' && 'token' in request.query
      ? String((request.query as { token?: unknown }).token ?? '')
      : ''
  const headerToken = String(request.headers['x-moyuan-runtime-token'] ?? '')
  const authHeader = String(request.headers.authorization ?? '')
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : ''

  if (queryToken === runtimeToken || headerToken === runtimeToken || bearerToken === runtimeToken) return

  return reply.status(401).send({ error: '未授权的本地 Runtime 请求' })
})

const taskSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().default(process.cwd()),
  employeeId: z.string().min(1),
  enterpriseApiBase: z.string().url().optional(),
  enterpriseAuthToken: z.string().optional(),
  parentTaskId: z.string().optional(),
  sessionId: z.string().optional(),
})

const approvalSchema = z.object({
  taskId: z.string(),
  decision: z.enum(['allow_once', 'deny']),
  reason: z.string().optional(),
})

const forkSchema = z.object({
  prompt: z.string().optional(),
})

const imageGenerationSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().default(process.cwd()),
  employeeId: z.string().min(1),
  enterpriseApiBase: z.string().url().optional(),
  enterpriseAuthToken: z.string().optional(),
  model: z.string().optional(),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1024'),
})

const records = new Map<string, TaskRecord>()
const runtimeRoot = process.env.MOYUAN_RUNTIME_HOME ?? path.join(tmpdir(), 'moyuan-runtime')
const storePath = path.join(runtimeRoot, 'sessions.json')
const memoryPath = path.join(runtimeRoot, 'workspace-memory.json')
const workspaceMemory = new Map<string, string>()
const mutedStderrPatterns = [
  'failed to warm featured plugin ids cache',
  'startup remote plugin sync failed',
  'skipping startup remote plugin sync',
  'chatgpt authentication required to sync remote plugins',
  'invalid_grant: Invalid refresh token',
  'failed to initialize MCP client during shutdown',
  'Reading additional input from stdin',
  'stream disconnected - retrying sampling request',
  'Reconnecting...',
]

function isInternalCodexJson(content: string) {
  const text = content.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return false

  try {
    const payload = JSON.parse(text) as { type?: unknown; item?: { type?: unknown } }
    const type = typeof payload.type === 'string' ? payload.type : ''
    const itemType = payload.item && typeof payload.item.type === 'string' ? payload.item.type : ''

    return (
      type.startsWith('item.') ||
      type.startsWith('turn.') ||
      type.includes('delta') ||
      itemType === 'web_search' ||
      itemType === 'reasoning' ||
      itemType === 'command_execution'
    )
  } catch {
    return text.includes('"type":"item.') || text.includes('"type":"web_search"')
  }
}

function isMutedTranscriptStatus(content: string) {
  const text = content.trim()
  return (
    /^正在生成图片[.。…]*$/.test(text) ||
    text.startsWith('当前已接入静态图片生成，还没有接入视频或动图生成') ||
    text === '正在调用视频生成技能...' ||
    text === '视频任务已创建，正在生成...' ||
    text === '视频仍在生成中' ||
    text.startsWith('当前状态：')
  )
}

function sanitizeTask(task: CodexTask): CodexTask {
  const transcript = compactTranscript(
    task.transcript
      .filter((item) => {
        const content = item.content.trim()
        return content && !isInternalCodexJson(content) && !isMoyuanToolCallContent(content) && !isMutedTranscriptStatus(content) && !isRawRuntimeFailure(content)
      })
      .map((item) => ({ ...item, content: friendlyRuntimeMessage(item.content) })),
  )

  if (task.status === 'failed' && transcript.length === 1 && transcript[0]?.role === 'user') {
    transcript.push({
      role: 'system',
      content: '模型服务暂时不可用，请检查模型密钥或稍后重试。',
      timestamp: task.updatedAt ?? transcript[0].timestamp,
    })
  }

  return {
    ...task,
    transcript,
  }
}

function compactTranscript(items: CodexTask['transcript']) {
  return items.reduce<CodexTask['transcript']>((merged, item) => {
    const previous = merged.at(-1)
    if (previous?.role === 'assistant' && item.role === 'assistant') {
      if (previous.itemId && item.itemId && previous.itemId === item.itemId) {
        merged[merged.length - 1] = {
          ...item,
          content: mergeAssistantContent(previous.content, item.content),
        }
        return merged
      }
      if (item.content.startsWith(previous.content)) {
        merged[merged.length - 1] = { ...item, content: mergeAssistantContent(previous.content, item.content) }
        return merged
      }
      if (previous.content.startsWith(item.content)) return merged
    }
    merged.push(item)
    return merged
  }, [])
}

function sharedPrefixSuffixLength(left: string, right: string) {
  const maxLength = Math.min(left.length, right.length)
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length
  }
  return 0
}

function mergeAssistantContent(current: string, incoming: string) {
  if (!current) return incoming
  if (!incoming) return current
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  const overlap = sharedPrefixSuffixLength(current, incoming)
  return `${current}${incoming.slice(overlap)}`
}

function isRawRuntimeFailure(content: string) {
  const text = content.trim()
  return (
    /^Codex\s*任务退出，代码/.test(text) ||
    text.startsWith('Missing environment variable:') ||
    text.includes('unexpected status 403 Forbidden: invalid api key') ||
    text.includes('invalid api key') ||
    text.startsWith('Codex app-server')
  )
}

function friendlyRuntimeMessage(content: string) {
  if (/not activated the model|has not activated the model|activate the model service/i.test(content)) {
    return '火山方舟视频模型还没有开通，请管理员到 Ark 控制台开通当前视频模型后再试。'
  }
  if (/OPENAI_API_KEY|invalid api key|403 Forbidden/i.test(content)) {
    return '模型服务暂时不可用，请检查模型密钥或稍后重试。'
  }
  if (/Codex app-server|Codex Runtime|ECONNREFUSED|connection/i.test(content)) {
    return '本地 Codex 内核暂时没有启动成功，我会继续尝试恢复。'
  }
  return content.replace(/%!s\(int64=(\d+)\)/g, '$1')
}

function resolveCodexBin() {
  return require.resolve('@openai/codex/bin/codex.js')
}

async function saveStore() {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    storePath,
    JSON.stringify({ tasks: Array.from(records.values()).map((record) => sanitizeTask(record.task)) }, null, 2),
  )
}

async function saveMemory() {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(memoryPath, JSON.stringify(Object.fromEntries(workspaceMemory.entries()), null, 2))
}

async function loadStore() {
  await mkdir(runtimeRoot, { recursive: true })

  try {
    const raw = await readFile(storePath, 'utf8')
    const saved = JSON.parse(raw) as { tasks?: CodexTask[] }
    for (const task of saved.tasks ?? []) {
      const restored = sanitizeTask(task)
      if (restored.status === 'queued' || restored.status === 'running') {
        restored.status = 'failed'
        restored.updatedAt = new Date().toISOString()
        restored.transcript.push({
          role: 'system',
          content: '上次本地 Runtime 重启，这个任务已中断，可以重新发送。',
          timestamp: restored.updatedAt,
        })
      }
      records.set(restored.id, { task: restored, events: [], subscribers: new Set(), streamItemIndexes: new Map() })
    }
  } catch {
    await saveStore()
  }

  try {
    const raw = await readFile(memoryPath, 'utf8')
    const saved = JSON.parse(raw) as Record<string, string>
    for (const [workspace, memory] of Object.entries(saved)) {
      workspaceMemory.set(workspace, memory)
    }
  } catch {
    await saveMemory()
  }
}

async function getGitDiff(workspace: string) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workspace, 'diff', '--stat'], { timeout: 4000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

async function createCodexHome() {
  const config = getModelConfig()
  const codexHome = process.env.MOYUAN_CODEX_HOME ?? path.join(tmpdir(), 'moyuan-codex', 'default')

  await mkdir(codexHome, { recursive: true })
  await writeFile(
    path.join(codexHome, 'config.toml'),
    [
      `model_provider = "${config.providerId}"`,
      `model = "${config.defaultModel}"`,
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"',
      'disable_response_storage = true',
      '',
      '[features]',
      'remote_plugin = false',
      'plugin_sharing = false',
      '',
      `[model_providers.${config.providerId}]`,
      `name = "${config.providerName}"`,
      `base_url = "${config.baseUrl}"`,
      `env_key = "${config.envKey}"`,
      '',
    ].join('\n'),
  )

  return codexHome
}

function resolveAssistantItemId(record: TaskRecord, event: CodexTaskEvent) {
  if (event.role !== 'assistant') return undefined

  const explicitItemId = event.itemId ?? rawItemId(event.raw)
  if (explicitItemId) {
    record.activeAssistantItemId = explicitItemId
    return explicitItemId
  }

  if (event.type === 'message_delta') {
    record.activeAssistantItemId ??= `assistant-${record.task.id}-${record.events.length + 1}`
    return record.activeAssistantItemId
  }

  if (event.type === 'message' && record.activeAssistantItemId) return record.activeAssistantItemId

  return `assistant-${record.task.id}-${record.events.length + 1}`
}

function pushEvent(record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) {
  let next: CodexTaskEvent = {
    ...event,
    id: `${event.taskId}-${record.events.length + 1}`,
    timestamp: new Date().toISOString(),
  }
  const assistantItemId = resolveAssistantItemId(record, next)
  if (assistantItemId) next = { ...next, itemId: assistantItemId }

  if (next.type === 'thread.started' && next.raw && typeof next.raw === 'object') {
    const threadId = (next.raw as { thread_id?: unknown }).thread_id
    if (typeof threadId === 'string') {
      record.task.sessionId = threadId
    }
  }

  if (!next.content && next.type !== 'thread.started') return

  record.events.push(next)

  if (next.type === 'message_delta') {
    const itemId = next.itemId ?? `assistant-${record.events.length}`
    const existingIndex = record.streamItemIndexes.get(itemId)

    if (existingIndex === undefined) {
      record.streamItemIndexes.set(itemId, record.task.transcript.length)
      record.task.transcript.push({
        role: 'assistant',
        content: next.content,
        itemId,
        timestamp: next.timestamp,
      })
    } else {
      const current = record.task.transcript[existingIndex]
      const content = mergeAssistantContent(current.content, next.content)
      record.task.transcript[existingIndex] = { ...current, content, timestamp: next.timestamp }
    }
  } else if (next.type === 'message' && next.role === 'assistant') {
    const itemId = next.itemId ?? rawItemId(next.raw)
    const existingIndex = itemId ? record.streamItemIndexes.get(itemId) : undefined
    if (existingIndex !== undefined) {
      const current = record.task.transcript[existingIndex]
      record.task.transcript[existingIndex] = { ...current, content: mergeAssistantContent(current.content, next.content), timestamp: next.timestamp }
    } else if (record.task.transcript.at(-1)?.role !== 'assistant' || record.task.transcript.at(-1)?.content !== next.content) {
      record.task.transcript.push({
        role: next.role,
        content: next.content,
        itemId,
        timestamp: next.timestamp,
      })
    }
    if (record.activeAssistantItemId === itemId) record.activeAssistantItemId = undefined
  } else if (next.content) {
    record.task.transcript.push({
      role: next.role,
      content: next.content,
      itemId: next.itemId,
      timestamp: next.timestamp,
    })
  }

  record.task.updatedAt = next.timestamp
  if (next.role === 'tool' && next.content.startsWith('$ ')) {
    record.task.commandHistory = [...(record.task.commandHistory ?? []), next.content].slice(-80)
  }
  void saveStore()

  for (const subscriber of record.subscribers) {
    subscriber(next)
  }
}

function rawItemId(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const direct = firstString((raw as { itemId?: unknown }).itemId, (raw as { item_id?: unknown }).item_id)
  if (direct) return direct
  const item = (raw as { item?: unknown }).item
  if (!item || typeof item !== 'object') return undefined
  const id = firstString((item as { id?: unknown }).id, (item as { itemId?: unknown }).itemId, (item as { item_id?: unknown }).item_id)
  return id || undefined
}

function rawWithItemId(raw: unknown, fallbackId: string) {
  if (rawItemId(raw)) return raw
  return { item: { id: fallbackId, type: 'agent_message' }, payload: raw }
}

function assistantStreamChunks(content: string) {
  const chars = Array.from(content)
  const chunkSize = Math.max(1, Math.min(10, Math.ceil(chars.length / 90)))
  const chunks: string[] = []
  for (let index = 0; index < chars.length; index += chunkSize) {
    chunks.push(chars.slice(index, index + chunkSize).join(''))
  }
  return chunks
}

async function streamAssistantMessage(record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) {
  const itemId = rawItemId(event.raw) ?? `assistant-final-${record.events.length + 1}`
  const raw = rawWithItemId(event.raw, itemId)

  if (record.streamItemIndexes.has(itemId)) {
    pushEvent(record, { ...event, raw })
    return
  }

  let visible = ''
  for (const chunk of assistantStreamChunks(event.content)) {
    visible += chunk
    pushEvent(record, {
      ...event,
      type: 'message_delta',
      content: visible,
      raw,
    })
    await sleep(18)
  }

  pushEvent(record, { ...event, raw })
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function normalizedType(value: unknown) {
  return typeof value === 'string' ? value.replace(/[_-]/g, '').toLowerCase() : ''
}

function isAgentMessageItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  return normalizedType(item?.type) === 'agentmessage'
}

function isCommandExecutionItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  return normalizedType(item?.type) === 'commandexecution'
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''

  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      return firstString(record.text, record.content, record.value)
    })
    .filter(Boolean)
    .join('')
}

function assistantTextFromItem(item: Record<string, unknown> | null, params?: Record<string, unknown>) {
  if (!item) return ''
  return firstString(
    item.text,
    item.outputText,
    item.output_text,
    item.message,
    textFromContent(item.content),
    params?.text,
    params?.outputText,
    params?.output_text,
    params?.message,
    textFromContent(params?.content),
  )
}

function assistantDeltaFromParams(params: Record<string, unknown>) {
  return firstString(params.delta, params.text, params.outputText, params.output_text, params.message, textFromContent(params.content))
}

function compactJson(payload: unknown) {
  try {
    return JSON.stringify(payload)
  } catch {
    return ''
  }
}

function eventFromJson(taskId: string, payload: unknown): Omit<CodexTaskEvent, 'id' | 'timestamp'> {
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const type = typeof obj.type === 'string' ? obj.type : 'message'
  const message = typeof obj.message === 'string' ? obj.message : ''
  const item = obj.item && typeof obj.item === 'object' ? (obj.item as Record<string, unknown>) : null
  const itemId = rawItemId(payload)

  if (type === 'item.updated' && isAgentMessageItem(item)) {
    const content = firstString(item.text, item.delta, obj.delta, obj.text, textFromContent(item.content), textFromContent(obj.content))

    return {
      taskId,
      type: 'message_delta',
      role: 'assistant',
      content,
      itemId,
      raw: payload,
    }
  }

  if (type === 'item.completed' && isAgentMessageItem(item)) {
    return {
      taskId,
      type: 'message',
      role: 'assistant',
      content: assistantTextFromItem(item, obj),
      itemId,
      raw: payload,
    }
  }

  if ((type === 'item.started' || type === 'item.completed') && isCommandExecutionItem(item)) {
    if (type === 'item.started') {
      return {
        taskId,
        type: 'tool',
        role: 'tool',
        content: '',
        itemId,
        raw: payload,
      }
    }

    const command = firstString(item.command, item.commandLine, item.command_line)
    const output = firstString(item.aggregated_output, item.aggregatedOutput, item.output).trim()
    const status = typeof item.status === 'string' ? item.status : 'completed'
    const rawExitCode = typeof item.exit_code === 'number' ? item.exit_code : typeof item.exitCode === 'number' ? item.exitCode : undefined
    const exitCode = typeof rawExitCode === 'number' ? `\nexit ${rawExitCode}` : ''
    const body = output ? `$ ${command}\n${output}${exitCode}` : `$ ${command}\n${status}`

    return {
      taskId,
      type: 'tool',
      role: 'tool',
      content: body,
      itemId,
      raw: payload,
    }
  }

  if (type === 'item.started' || type === 'item.completed') {
    return {
      taskId,
      type: 'message',
      role: 'system',
      content: '',
      raw: payload,
    }
  }

  if (type.includes('error') || type === 'turn.failed') {
    return {
      taskId,
      type: type === 'turn.failed' ? 'turn.failed' : 'error',
      role: 'system',
      content: message || compactJson(payload),
      raw: payload,
    }
  }

  if (type.includes('exec') || type.includes('tool')) {
    return {
      taskId,
      type: 'tool',
      role: 'tool',
      content: message,
      raw: payload,
    }
  }

  if (type === 'turn.completed') {
    return { taskId, type: 'turn.completed', role: 'system', content: '任务完成', raw: payload }
  }

  if (type === 'thread.started' || type === 'turn.started') {
    return { taskId, type, role: 'system', content: '', raw: payload }
  }

  if (!message) {
    return {
      taskId,
      type: 'message',
      role: 'system',
      content: '',
      raw: payload,
    }
  }

  return {
    taskId,
    type: 'message',
    role: 'assistant',
    content: message,
    raw: payload,
  }
}

function findOpenPort(start = 49200) {
  return new Promise<number>((resolve, reject) => {
    let port = start + Math.floor(Math.random() * 200)

    const tryPort = () => {
      if (port > start + 500) {
        reject(new Error('没有可用的本地 app-server 端口'))
        return
      }

      const server = createServer()
      server.once('error', () => {
        port += 1
        tryPort()
      })
      server.once('listening', () => {
        server.close(() => resolve(port))
      })
      server.listen(port, '127.0.0.1')
    }

    tryPort()
  })
}

function appServerRaw(itemId: string) {
  return { item: { id: itemId, type: 'agent_message' } }
}

async function connectAppServer(url: string, onNotification: (message: Record<string, unknown>) => void) {
  type PendingRequest = {
    reject: (error: Error) => void
    resolve: (value: unknown) => void
  }

  const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => {
    close: () => void
    onclose: ((event: unknown) => void) | null
    onerror: ((event: unknown) => void) | null
    onmessage: ((event: { data: unknown }) => void) | null
    onopen: (() => void) | null
    send: (data: string) => void
  } }).WebSocket

  if (!WebSocketCtor) throw new Error('当前 Node 运行时不支持 WebSocket')

  let requestId = 1
  const pending = new Map<number, PendingRequest>()
  const openSocket = () =>
    new Promise<InstanceType<typeof WebSocketCtor>>((resolve, reject) => {
      const ws = new WebSocketCtor(url)
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {
          // Ignore close errors while retrying startup.
        }
        settle(() => reject(new Error('Codex app-server 连接超时')))
      }, 1200)

      ws.onopen = () => settle(() => resolve(ws as InstanceType<typeof WebSocketCtor>))
      ws.onerror = () => settle(() => reject(new Error('Codex app-server 连接失败')))
      ws.onclose = () => settle(() => reject(new Error('Codex app-server 已断开')))
    })

  let socket: InstanceType<typeof WebSocketCtor> | undefined
  let lastConnectError: unknown
  const connectDeadline = Date.now() + 10000
  while (!socket && Date.now() < connectDeadline) {
    try {
      socket = await openSocket()
    } catch (error) {
      lastConnectError = error
      await sleep(160)
    }
  }

  if (!socket) {
    throw lastConnectError instanceof Error ? lastConnectError : new Error('Codex app-server 连接失败')
  }

  socket.onmessage = (event) => {
    const raw = typeof event.data === 'string' ? event.data : String(event.data)
    const message = JSON.parse(raw) as Record<string, unknown>
    const id = typeof message.id === 'number' ? message.id : undefined

    if (id !== undefined) {
      const waiter = pending.get(id)
      if (!waiter) return
      pending.delete(id)
      const error = message.error as { message?: string } | undefined
      if (error) {
        waiter.reject(new Error(error.message ?? 'Codex app-server 请求失败'))
      } else {
        waiter.resolve(message.result)
      }
      return
    }

    onNotification(message)
  }

  socket.onclose = () => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error('Codex app-server 已断开'))
    }
    pending.clear()
  }

  return {
    close() {
      socket.close()
    },
    request(method: string, params: unknown) {
      const id = requestId
      requestId += 1
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

function appServerThreadId(result: unknown) {
  const thread = result && typeof result === 'object' ? (result as { thread?: unknown }).thread : undefined
  if (!thread || typeof thread !== 'object') return undefined
  const id = (thread as { id?: unknown; threadId?: unknown }).id ?? (thread as { id?: unknown; threadId?: unknown }).threadId
  return typeof id === 'string' ? id : undefined
}

function appServerTurnId(result: unknown) {
  const turn = result && typeof result === 'object' ? (result as { turn?: unknown }).turn : undefined
  if (!turn || typeof turn !== 'object') return undefined
  const id = (turn as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

function appServerSandboxPolicy(workspace: string) {
  return {
    type: 'workspaceWrite',
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

function terminateProcessTree(child: ReturnType<typeof spawn>) {
  const pid = child.pid
  if (!pid) return

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // Ignore termination races.
    }
  }

  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // The process already exited.
      }
    }
  }, 800).unref()
}

async function finishCodexTask(record: TaskRecord, taskId: string, code: number | null) {
  record.task.exitCode = code
  record.task.status = code === 0 && record.task.status !== 'failed' ? 'completed' : 'failed'
  record.task.updatedAt = new Date().toISOString()
  const diff = await getGitDiff(record.task.workspace)
  record.task.diffSummary = diff
  if (diff) {
    workspaceMemory.set(
      record.task.workspace,
      [`最近会话: ${record.task.title}`, `Codex session: ${record.task.sessionId ?? 'unknown'}`, `最近 diff:\n${diff}`].join('\n'),
    )
    await saveMemory()
  }
  await saveStore()
  pushEvent(record, {
    taskId,
    type: 'process.exit',
    role: 'system',
    content: record.task.status === 'completed' ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
  })
}

async function runCodexAppServer(record: TaskRecord, prompt: string, workspace: string, sessionId: string | undefined, options: RuntimeRunOptions) {
  const taskId = record.task.id
  const codexHome = await createCodexHome()
  const codexBin = resolveCodexBin()
  const config = getModelConfig()
  const skills = await loadEnterpriseSkillSet(options.enterpriseAuthToken, options.enterpriseApiBase)
  const skillInstructions = buildSkillInstructionBlock(skills)
  const port = await findOpenPort()
  const appServerUrl = `ws://127.0.0.1:${port}`
  const memory = workspaceMemory.get(workspace)
  const commandContext = record.task.commandHistory?.slice(-8).join('\n\n')
  const diffSummary = await getGitDiff(workspace)
  const contextBlock = [
    skillInstructions,
    memory ? `工作区记忆:\n${memory}` : '',
    commandContext ? `最近命令历史:\n${commandContext}` : '',
    diffSummary ? `当前文件变更摘要:\n${diffSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const promptWithContext = contextBlock ? `${contextBlock}\n\n用户本轮请求:\n${prompt}` : prompt

  record.task.status = 'running'
  await saveStore()

  let activeTurnId = ''
  let fallbackAssistantItemId = ''
  let completed = false
  let failed = false
  let resolveTurn: (() => void) | undefined
  let rejectTurn: ((error: Error) => void) | undefined
  const turnFinished = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })
  const assistantDeltaBuffers = new Map<string, string>()
  const pendingToolRuns: Promise<void>[] = []

  const startToolRun = (toolCall: ReturnType<typeof parseMoyuanToolCall>) => {
    if (!toolCall) return false
    const toolRun = runMoyuanToolCall({ record, toolCall, prompt, options, skills, runtimeRoot, saveStore, pushEvent })
    pendingToolRuns.push(toolRun)
    void toolRun
    return true
  }

  const flushBufferedAssistantItems = () => {
    for (const [itemId, content] of Array.from(assistantDeltaBuffers.entries())) {
      const toolCall = parseMoyuanToolCall(content)
      assistantDeltaBuffers.delete(itemId)
      if (startToolRun(toolCall)) continue
      if (!content.trim()) continue
      pushEvent(record, {
        taskId,
        type: 'message',
        role: 'assistant',
        content,
        raw: appServerRaw(itemId),
      })
    }
  }

  const child = spawn(process.execPath, [codexBin, 'app-server', '--listen', appServerUrl, '--disable', 'remote_plugin', '--disable', 'plugin_sharing'], {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: process.env.AI_API_KEY ?? '',
      RUST_LOG: process.env.CODEX_RUST_LOG ?? 'warn',
    },
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (!text) return
    if (mutedStderrPatterns.some((pattern) => text.includes(pattern))) return
    app.log.debug({ text }, 'codex app-server stderr')
  })

  child.once('exit', (code) => {
    if (!completed && !failed) {
      rejectTurn?.(new Error(`Codex app-server 退出，代码 ${code ?? 'unknown'}`))
    }
  })

  const connection = await connectAppServer(appServerUrl, (message) => {
    const method = typeof message.method === 'string' ? message.method : ''
    const methodKey = method.replace(/[\/_.-]/g, '').toLowerCase()
    const params = message.params && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : {}
    const item =
      params.item && typeof params.item === 'object'
        ? (params.item as Record<string, unknown>)
        : params.type
          ? params
          : null
    const explicitItemId = firstString(params.itemId, params.item_id, item?.id)
    const isAssistantNotification =
      (methodKey.includes('agentmessage') && (methodKey.includes('delta') || methodKey.includes('completed'))) ||
      (methodKey === 'itemupdated' && isAgentMessageItem(item)) ||
      (methodKey === 'itemcompleted' && isAgentMessageItem(item))
    const itemId = explicitItemId || (isAssistantNotification ? fallbackAssistantItemId || `app-assistant-${activeTurnId || taskId}` : `app-item-${record.events.length}`)
    if (isAssistantNotification && !explicitItemId) fallbackAssistantItemId = itemId

    if ((methodKey.includes('agentmessage') && methodKey.includes('delta')) || (methodKey === 'itemupdated' && isAgentMessageItem(item))) {
      const delta = assistantDeltaFromParams(params) || firstString(item?.delta, item?.text, textFromContent(item?.content))
      if (!delta) return
      const buffered = assistantDeltaBuffers.get(itemId)
      const combined = `${buffered ?? ''}${delta}`
      if (buffered !== undefined || isLikelyToolCallFragment(combined)) {
        if (isLikelyToolCallFragment(combined)) {
          assistantDeltaBuffers.set(itemId, combined)
          return
        }
        assistantDeltaBuffers.delete(itemId)
        pushEvent(record, {
          taskId,
          type: 'message_delta',
          role: 'assistant',
          content: combined,
          itemId,
          raw: appServerRaw(itemId),
        })
        return
      }
      pushEvent(record, {
        taskId,
        type: 'message_delta',
        role: 'assistant',
        content: delta,
        itemId,
        raw: appServerRaw(itemId),
      })
      return
    }

    if (methodKey === 'itemcompleted' || (methodKey.includes('agentmessage') && methodKey.includes('completed'))) {
      if (isAgentMessageItem(item)) {
        const content = assistantTextFromItem(item, params) || assistantDeltaBuffers.get(itemId) || ''
        assistantDeltaBuffers.delete(itemId)
        const toolCall = parseMoyuanToolCall(content)
        if (startToolRun(toolCall)) {
          if (fallbackAssistantItemId === itemId) fallbackAssistantItemId = ''
          return
        }
        if (!content.trim()) return
        pushEvent(record, {
          taskId,
          type: 'message',
          role: 'assistant',
          content,
          itemId,
          raw: appServerRaw(itemId),
        })
        if (fallbackAssistantItemId === itemId) fallbackAssistantItemId = ''
        return
      }

      if (isCommandExecutionItem(item)) {
        const commandItem = item as Record<string, unknown>
        const command = firstString(commandItem.command, commandItem.commandLine, commandItem.command_line)
        const output = firstString(commandItem.aggregatedOutput, commandItem.aggregated_output, commandItem.output).trim()
        const status = typeof commandItem.status === 'string' ? commandItem.status : 'completed'
        const rawExitCode =
          typeof commandItem.exitCode === 'number' ? commandItem.exitCode : typeof commandItem.exit_code === 'number' ? commandItem.exit_code : undefined
        const exitCode = typeof rawExitCode === 'number' ? `\nexit ${rawExitCode}` : ''
        const body = output ? `$ ${command}\n${output}${exitCode}` : `$ ${command}\n${status}`
        pushEvent(record, {
          taskId,
          type: 'tool',
          role: 'tool',
          content: body,
          raw: { item: { id: itemId, type: 'command_execution' } },
        })
      }
      return
    }

    if (methodKey === 'turncompleted') {
      completed = true
      flushBufferedAssistantItems()
      if (!pendingToolRuns.length) record.task.status = 'completed'
      pushEvent(record, {
        taskId,
        type: 'turn.completed',
        role: 'system',
        content: '任务完成',
      })
      resolveTurn?.()
      return
    }

    if (methodKey === 'error') {
      const willRetry = params.willRetry === true
      if (willRetry) return
      failed = true
      const error = params.error && typeof params.error === 'object' ? (params.error as { message?: unknown }) : {}
      pushEvent(record, {
        taskId,
        type: 'turn.failed',
        role: 'system',
        content: typeof error.message === 'string' ? friendlyRuntimeMessage(error.message) : '模型服务暂时不可用，请稍后重试。',
      })
      rejectTurn?.(new Error(typeof error.message === 'string' ? error.message : 'Codex app-server turn failed'))
      return
    }

    const rawPayload =
      params.type && typeof params.type === 'string'
        ? params
        : message.type && typeof message.type === 'string'
          ? message
          : undefined
    if (rawPayload) {
      const event = eventFromJson(taskId, rawPayload)
      if (event.type === 'message_delta' && event.role === 'assistant') {
        const itemIdFromRaw = rawItemId(event.raw) ?? itemId
        const combined = `${assistantDeltaBuffers.get(itemIdFromRaw) ?? ''}${event.content}`
        if (isLikelyToolCallFragment(combined)) {
          assistantDeltaBuffers.set(itemIdFromRaw, combined)
          return
        }
      }
      const eventWithItemId = event.role === 'assistant' ? { ...event, itemId: rawItemId(event.raw) ?? itemId } : event
      if (eventWithItemId.type === 'message' && eventWithItemId.role === 'assistant') {
        const toolCall = parseMoyuanToolCall(eventWithItemId.content)
        if (startToolRun(toolCall)) return
      }
      if (eventWithItemId.type === 'turn.completed') {
        completed = true
        flushBufferedAssistantItems()
        if (!pendingToolRuns.length) record.task.status = 'completed'
        pushEvent(record, eventWithItemId)
        resolveTurn?.()
        return
      }
      pushEvent(record, eventWithItemId)
    }
  })

  try {
    await connection.request('initialize', {
      clientInfo: { name: 'moyuan-desktop', title: 'Moyuan Desktop', version: '0.1.3' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    })

    const threadResult = sessionId
      ? await connection.request('thread/resume', {
          threadId: sessionId,
          cwd: workspace,
          model: config.defaultModel,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          baseInstructions: skillInstructions,
          persistExtendedHistory: false,
        })
      : await connection.request('thread/start', {
          cwd: workspace,
          model: config.defaultModel,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          baseInstructions: skillInstructions,
          threadSource: 'user',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })
    const threadId = appServerThreadId(threadResult)
    if (!threadId) throw new Error('Codex app-server 没有返回会话 id')
    record.task.sessionId = threadId
    pushEvent(record, {
      taskId,
      type: 'thread.started',
      role: 'system',
      content: '',
      raw: { thread_id: threadId },
    })

    const turnResult = await connection.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: promptWithContext, text_elements: [] }],
      cwd: workspace,
      approvalPolicy: 'never',
      sandboxPolicy: appServerSandboxPolicy(workspace),
      model: config.defaultModel,
    })
    activeTurnId = appServerTurnId(turnResult) ?? ''
    await turnFinished
    await Promise.allSettled(pendingToolRuns)
    await finishCodexTask(record, taskId, 0)
  } catch (error) {
    record.task.status = 'failed'
    await saveStore()
    throw error
  } finally {
    connection.close()
    terminateProcessTree(child)
  }
}

async function runCodex(record: TaskRecord, prompt: string, workspace: string, sessionId: string | undefined, options: RuntimeRunOptions = {}) {
  if (process.env.MOYUAN_CODEX_TRANSPORT === 'exec') {
    await runCodexExec(record, prompt, workspace, sessionId, options)
    return
  }

  await runCodexAppServer(record, prompt, workspace, sessionId, options)
}

async function runCodexExec(record: TaskRecord, prompt: string, workspace: string, sessionId: string | undefined, options: RuntimeRunOptions) {
  const taskId = record.task.id
  const codexHome = await createCodexHome()
  const codexBin = resolveCodexBin()
  const config = getModelConfig()
  const skills = await loadEnterpriseSkillSet(options.enterpriseAuthToken, options.enterpriseApiBase)
  const skillInstructions = buildSkillInstructionBlock(skills)
  const commonArgs = [
    '--json',
    '--skip-git-repo-check',
    '--disable',
    'remote_plugin',
    '--disable',
    'plugin_sharing',
    '-c',
    'approval_policy="never"',
    '-c',
    'sandbox_mode="workspace-write"',
    '-m',
    config.defaultModel,
  ]
  const memory = workspaceMemory.get(workspace)
  const commandContext = record.task.commandHistory?.slice(-8).join('\n\n')
  const diffSummary = await getGitDiff(workspace)
  const contextBlock = [
    skillInstructions,
    memory ? `工作区记忆:\n${memory}` : '',
    commandContext ? `最近命令历史:\n${commandContext}` : '',
    diffSummary ? `当前文件变更摘要:\n${diffSummary}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const promptWithContext = contextBlock ? `${contextBlock}\n\n用户本轮请求:\n${prompt}` : prompt
  const args = sessionId
    ? [codexBin, 'exec', 'resume', ...commonArgs, sessionId, promptWithContext]
    : [codexBin, 'exec', ...commonArgs, '--sandbox', 'workspace-write', '-C', workspace, promptWithContext]

  record.task.status = 'running'

  const child = spawn(process.execPath, args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: process.env.AI_API_KEY ?? '',
      RUST_LOG: process.env.CODEX_RUST_LOG ?? 'warn',
    },
  })

  let buffer = ''
  const pendingAssistantStreams: Promise<void>[] = []
  const pendingToolRuns: Promise<void>[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      if (mutedStderrPatterns.some((pattern) => line.includes(pattern))) continue
      try {
        const event = eventFromJson(taskId, JSON.parse(line))
        if (event.type === 'message_delta' && event.role === 'assistant' && isLikelyToolCallFragment(event.content)) {
          continue
        }
        if (event.type === 'message' && event.role === 'assistant') {
          const toolCall = parseMoyuanToolCall(event.content)
          if (toolCall) {
            const toolRun = runMoyuanToolCall({ record, toolCall, prompt, options, skills, runtimeRoot, saveStore, pushEvent })
            pendingToolRuns.push(toolRun)
            void toolRun
            continue
          }
          pendingAssistantStreams.push(streamAssistantMessage(record, event))
          continue
        }
        pushEvent(record, event)
      } catch {
        if (/^\s*\{".+"\}\s*$/.test(line)) continue
        pendingAssistantStreams.push(streamAssistantMessage(record, {
          taskId,
          type: 'message',
          role: 'assistant',
          content: line,
        }))
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (!text) return
    if (mutedStderrPatterns.some((pattern) => text.includes(pattern))) return
    pushEvent(record, {
      taskId,
      type: 'error',
      role: 'system',
      content: text,
    })
  })

  child.on('exit', (code) => {
    record.task.exitCode = code
    void (async () => {
      await Promise.allSettled(pendingAssistantStreams)
      await Promise.allSettled(pendingToolRuns)
      record.task.status = code === 0 && record.task.status !== 'failed' ? 'completed' : 'failed'
      record.task.updatedAt = new Date().toISOString()
      const diff = await getGitDiff(record.task.workspace)
      record.task.diffSummary = diff
      if (diff) {
        workspaceMemory.set(
          record.task.workspace,
          [`最近会话: ${record.task.title}`, `Codex session: ${record.task.sessionId ?? 'unknown'}`, `最近 diff:\n${diff}`].join('\n'),
        )
        void saveMemory()
      }
      void saveStore()
      pushEvent(record, {
        taskId,
        type: 'process.exit',
        role: 'system',
        content: record.task.status === 'completed' ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
      })
    })()
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

app.get('/health', async () => ({
  ok: true,
  service: 'codex-runtime',
  bundledCodex: true,
  codexBin: resolveCodexBin(),
  host: runtimeHost,
  protected: Boolean(runtimeToken),
  model: getModelConfig(),
  image: getImageConfig(),
}))

await loadStore()
await saveStore()

app.post('/api/codex/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '任务参数不完整', detail: parsed.error.flatten() })
  }

  const quota = await validateEnterpriseQuota(parsed.data.enterpriseAuthToken, parsed.data.enterpriseApiBase)
  if (!quota.ok) {
    return reply.status(quota.statusCode ?? 500).send({ error: quota.error ?? '额度校验失败' })
  }

  const now = new Date().toISOString()
  const existingRecord = parsed.data.parentTaskId ? records.get(parsed.data.parentTaskId) : undefined
  const task: CodexTask =
    existingRecord?.task ?? {
      id: `codex-${Date.now()}`,
      title: parsed.data.prompt.slice(0, 36),
      status: 'queued',
      workspace: parsed.data.workspace,
      sessionId: parsed.data.sessionId,
      createdAt: now,
      updatedAt: now,
      exitCode: null,
      transcript: [],
    }

  task.status = 'queued'
  task.workspace = parsed.data.workspace
  task.workspaceMemory = workspaceMemory.get(parsed.data.workspace)
  task.diffSummary = await getGitDiff(parsed.data.workspace)
  task.updatedAt = now
  task.transcript.push({
    role: 'user',
    content: parsed.data.prompt,
    timestamp: now,
  })

  const record: TaskRecord = existingRecord ?? { task, events: [], subscribers: new Set(), streamItemIndexes: new Map() }
  records.set(task.id, record)
  await saveStore()

  void runCodex(record, parsed.data.prompt, parsed.data.workspace, parsed.data.sessionId ?? task.sessionId, {
    enterpriseApiBase: parsed.data.enterpriseApiBase,
    enterpriseAuthToken: parsed.data.enterpriseAuthToken,
  }).catch((error: unknown) => {
    task.status = 'failed'
    pushEvent(record, {
      taskId: task.id,
      type: 'turn.failed',
      role: 'system',
      content: error instanceof Error ? error.message : String(error),
    })
  })

  return { data: task }
})

app.get('/api/codex/tasks', async () => ({
  data: Array.from(records.values()).map((record) => sanitizeTask(record.task)),
}))

app.post('/api/images/generations', async (request, reply) => {
  const parsed = imageGenerationSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '图片生成参数不完整', detail: parsed.error.flatten() })
  }

  const now = new Date().toISOString()
  const task: CodexTask = {
    id: `image-${Date.now()}`,
    title: `生成图片：${parsed.data.prompt.slice(0, 24)}`,
    status: 'running',
    workspace: parsed.data.workspace,
    createdAt: now,
    updatedAt: now,
    exitCode: null,
    transcript: [
      {
        role: 'user',
        content: parsed.data.prompt,
        timestamp: now,
      },
    ],
  }
  const record: TaskRecord = { task, events: [], subscribers: new Set(), streamItemIndexes: new Map() }
  records.set(task.id, record)
  await saveStore()
  const skills = await loadEnterpriseSkillSet(parsed.data.enterpriseAuthToken, parsed.data.enterpriseApiBase)
  void runImageGenerationTool({
    record,
    prompt: parsed.data.prompt,
    runtimeRoot,
    saveStore,
    pushEvent,
    size: parsed.data.size,
    model: parsed.data.model,
    options: {
      enterpriseApiBase: parsed.data.enterpriseApiBase,
      enterpriseAuthToken: parsed.data.enterpriseAuthToken,
    },
    skills,
  })

  return { data: task }
})

app.get('/api/images/:fileName', async (request, reply) => {
  const params = z.object({ fileName: z.string().regex(/^[a-f0-9-]+\.png$/) }).parse(request.params)
  const imagePath = path.join(runtimeRoot, 'images', params.fileName)

  try {
    const image = await readFile(imagePath)
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=31536000, immutable').send(image)
  } catch {
    return reply.status(404).send({ error: '图片不存在' })
  }
})

app.get('/api/codex/tasks/:taskId', async (request, reply) => {
  const params = z.object({ taskId: z.string() }).parse(request.params)
  const record = records.get(params.taskId)

  if (!record) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  return { data: sanitizeTask(record.task) }
})

app.post('/api/codex/tasks/:taskId/fork', async (request, reply) => {
  const params = z.object({ taskId: z.string() }).parse(request.params)
  const parsed = forkSchema.safeParse(request.body ?? {})

  if (!parsed.success) {
    return reply.status(400).send({ error: 'fork 参数不完整', detail: parsed.error.flatten() })
  }

  const source = records.get(params.taskId)
  if (!source) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  const now = new Date().toISOString()
  const forked: CodexTask = {
    ...source.task,
    id: `codex-${Date.now()}`,
    title: `${source.task.title} fork`,
    status: 'queued',
    forkedFrom: source.task.id,
    createdAt: now,
    updatedAt: now,
    transcript: [...source.task.transcript],
  }

  const record: TaskRecord = { task: forked, events: [], subscribers: new Set(), streamItemIndexes: new Map() }
  records.set(forked.id, record)
  await saveStore()

  if (parsed.data.prompt) {
    forked.transcript.push({ role: 'user', content: parsed.data.prompt, timestamp: now })
    void runCodex(record, parsed.data.prompt, forked.workspace, forked.sessionId)
  }

  return { data: forked }
})

app.get('/api/codex/tasks/:taskId/events', async (request, reply) => {
  const params = z.object({ taskId: z.string() }).parse(request.params)
  const record = records.get(params.taskId)

  if (!record) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  })
  reply.raw.write(': connected\n\n')

  const send = (event: CodexTaskEvent) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  for (const event of record.events) send(event)

  record.subscribers.add(send)
  request.raw.on('close', () => {
    record.subscribers.delete(send)
  })
})

app.post('/api/codex/approvals', async (request, reply) => {
  const parsed = approvalSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '审批参数不完整', detail: parsed.error.flatten() })
  }

  const record = records.get(parsed.data.taskId)

  if (!record) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  pushEvent(record, {
    taskId: parsed.data.taskId,
    type: 'message',
    role: 'system',
    content: parsed.data.decision === 'allow_once' ? '员工允许本次动作。' : `员工拒绝动作：${parsed.data.reason ?? '未填写原因'}`,
  })

  return { data: record.task }
})

const port = Number(process.env.CODEX_RUNTIME_PORT ?? 4101)
await app.listen({ host: runtimeHost, port })
