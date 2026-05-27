import cors from '@fastify/cors'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import type { CodexTask, CodexTaskEvent, VideoGenerationResult } from '@eaw/shared'
import { buildSkillInstructionBlock, isLikelyToolCallFragment, parseMoyuanToolCall } from './skills/contracts.js'
import type { EnterpriseSkillSet, MoyuanToolCall, RuntimeRunOptions } from './skills/contracts.js'

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
const enterpriseApiBase = process.env.ENTERPRISE_API_BASE ?? 'http://codex.tminos.com:18080/admin-api'

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

type TaskRecord = {
  task: CodexTask
  events: CodexTaskEvent[]
  subscribers: Set<(event: CodexTaskEvent) => void>
  streamItemIndexes: Map<string, number>
}

type EnterpriseMeResponse = {
  data?: {
    user?: {
      tokenBudget: number
      tokenUsed: number
      status: string
    }
  }
  error?: string
}

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
    text.startsWith('当前已接入静态图片生成，还没有接入视频或动图生成')
  )
}

function sanitizeTask(task: CodexTask): CodexTask {
  const transcript = compactTranscript(
    task.transcript
      .filter((item) => {
        const content = item.content.trim()
        return content && !isInternalCodexJson(content) && !isMutedTranscriptStatus(content) && !isRawRuntimeFailure(content)
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
      if (item.content.startsWith(previous.content)) {
        merged[merged.length - 1] = item
        return merged
      }
      if (previous.content.startsWith(item.content)) return merged
    }
    merged.push(item)
    return merged
  }, [])
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
  if (/OPENAI_API_KEY|invalid api key|403 Forbidden/i.test(content)) {
    return '模型服务暂时不可用，请检查模型密钥或稍后重试。'
  }
  if (/Codex app-server|Codex Runtime|ECONNREFUSED|connection/i.test(content)) {
    return '本地 Codex 内核暂时没有启动成功，我会继续尝试恢复。'
  }
  return content
}

function getModelConfig() {
  return {
    providerId: process.env.AI_PROVIDER_ID ?? 'moyuan-blector',
    providerName: process.env.AI_PROVIDER_NAME ?? 'Moyuan OpenAI Compatible Proxy',
    baseUrl: process.env.AI_BASE_URL ?? 'https://ai.blector.com/v1',
    apiKeyConfigured: Boolean(process.env.AI_API_KEY),
    envKey: 'OPENAI_API_KEY',
    defaultModel: process.env.AI_MODEL ?? 'gpt-5.5',
  }
}

function getImageConfig() {
  return {
    baseUrl: process.env.IMAGE_BASE_URL ?? 'https://codex-manager.tminos.com/v1',
    apiKeyConfigured: Boolean(process.env.IMAGE_API_KEY),
    defaultModel: process.env.IMAGE_MODEL ?? 'gpt-image-2',
  }
}

function localSkillSet(): EnterpriseSkillSet {
  const image = getImageConfig()
  return {
    imageGeneration: {
      apiKeyConfigured: image.apiKeyConfigured,
      defaultModel: image.defaultModel,
      enabled: image.apiKeyConfigured,
      name: '静态图片生成',
    },
  }
}

async function loadEnterpriseSkillSet(authToken?: string, baseUrl = enterpriseApiBase): Promise<EnterpriseSkillSet> {
  const skills = localSkillSet()
  if (!authToken) return skills

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(enterpriseEndpoint(baseUrl, '/desktop/bootstrap'), {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => ({}))) as {
      data?: {
        runtime?: {
          skills?: {
            videoGeneration?: EnterpriseSkillSet['videoGeneration']
          }
        }
      }
    }
    const videoGeneration = payload.data?.runtime?.skills?.videoGeneration
    if (response.ok && videoGeneration) {
      skills.videoGeneration = videoGeneration
    }
  } catch {
    // Keep local tools available if the enterprise bootstrap endpoint is temporarily unavailable.
  } finally {
    clearTimeout(timeout)
  }

  return skills
}

function enterpriseEndpoint(baseUrl: string, pathname: string) {
  return `${baseUrl.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`
}

async function validateEnterpriseQuota(authToken?: string, baseUrl = enterpriseApiBase) {
  if (!authToken) return { ok: false, statusCode: 401, error: '请先登录墨渊账号' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(enterpriseEndpoint(baseUrl, '/me'), {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => ({}))) as EnterpriseMeResponse
    if (!response.ok || !payload.data?.user) {
      return { ok: false, statusCode: response.status || 401, error: payload.error ?? '登录状态已失效，请重新登录' }
    }

    const user = payload.data.user
    if (user.status !== 'active') return { ok: false, statusCode: 403, error: '账号已停用，请联系管理员' }
    if (user.tokenBudget - user.tokenUsed <= 0) {
      return { ok: false, statusCode: 402, error: 'Token 额度不足，请联系管理员派发额度' }
    }

    return { ok: true }
  } catch {
    return { ok: false, statusCode: 503, error: '企业后台暂时不可用，无法校验 Token 额度' }
  } finally {
    clearTimeout(timeout)
  }
}

function inferImageSize(prompt: string): '1024x1024' | '1024x1536' | '1536x1024' {
  if (/海报|封面|竖版|手机|小红书|portrait|poster|cover|mobile/i.test(prompt)) return '1024x1536'
  if (/横版|banner|横幅|壁纸|宽屏|landscape|wallpaper|wide/i.test(prompt)) return '1536x1024'
  return '1024x1024'
}

function buildImagePrompt(prompt: string) {
  const trimmed = prompt.trim()
  const asksForPublicFigure = /特朗普|川普|donald\s+trump|trump/i.test(trimmed)
  const asksForHotpot = /火锅|hot\s*pot|hotpot/i.test(trimmed)

  if (asksForPublicFigure && asksForHotpot) {
    return [
      'Editorial cartoon style illustration, clearly fictional and non-photorealistic.',
      'Donald Trump eating spicy Chongqing hot pot at a lively Chinese hot pot restaurant.',
      'Red chili oil broth, steam rising, Sichuan peppers, plates of vegetables and beef on the table.',
      'Warm restaurant lighting, humorous but respectful expression, high detail, polished digital art.',
      'Do not include text, logos, watermarks, or political campaign symbols.',
    ].join(' ')
  }

  return trimmed
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

async function generateImage(prompt: string, size: string, model?: string) {
  const config = getImageConfig()
  const apiKey = process.env.IMAGE_API_KEY

  if (!apiKey) {
    throw new Error('图片生成密钥未配置，请在 Runtime 环境变量中设置 IMAGE_API_KEY')
  }

  const imagePrompt = buildImagePrompt(prompt)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.IMAGE_TIMEOUT_MS ?? 300000))

  let response: Response
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model ?? config.defaultModel,
        prompt: imagePrompt,
        size,
        n: 1,
      }),
    })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('图片生成超时，请稍后重试或换一个更具体的描述')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const payload = (await response.json().catch(() => ({}))) as {
    data?: Array<{ b64_json?: string; url?: string }>
    error?: { message?: string }
    message?: string
  }

  if (!response.ok) {
    throw new Error(payload.error?.message ?? payload.message ?? `图片生成接口返回 ${response.status}`)
  }

  const b64Json = payload.data?.[0]?.b64_json
  if (!b64Json) {
    throw new Error('图片生成接口没有返回 b64_json')
  }

  const id = randomUUID()
  const fileName = `${id}.png`
  const imageDir = path.join(runtimeRoot, 'images')
  await mkdir(imageDir, { recursive: true })
  await writeFile(path.join(imageDir, fileName), Buffer.from(b64Json, 'base64'))

  return {
    id,
    prompt,
    model: model ?? config.defaultModel,
    size,
    url: `/api/images/${fileName}`,
    createdAt: new Date().toISOString(),
  }
}

function findFirstString(payload: unknown, keys: string[]): string | undefined {
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

function findFirstVideoUrl(payload: unknown): string | undefined {
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

function normalizedVideoStatus(status?: string) {
  const value = (status ?? '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'done', 'finish', 'finished'].some((item) => value.includes(item))) return 'completed'
  if (['failed', 'error', 'canceled', 'cancelled', 'rejected'].some((item) => value.includes(item))) return 'failed'
  return 'running'
}

async function enterpriseJson(pathname: string, authToken: string, baseUrl: string, init: RequestInit = {}) {
  const response = await fetch(enterpriseEndpoint(baseUrl, pathname), {
    ...init,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const payload = (await response.json().catch(() => ({}))) as { data?: unknown; error?: string; message?: string; upstream?: unknown }
  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `企业技能代理返回 ${response.status}`)
  }
  return payload.data
}

function buildVideoRequest(toolCall: Extract<MoyuanToolCall, { tool: 'video_generation' }>, prompt: string, skills: EnterpriseSkillSet) {
  const video = skills.videoGeneration
  return {
    content: toolCall.content?.length ? toolCall.content : [{ type: 'text', text: toolCall.prompt ?? prompt }],
    duration: toolCall.duration ?? video?.defaultDuration ?? 8,
    generate_audio: toolCall.generateAudio ?? true,
    model: toolCall.model ?? video?.defaultModel,
    prompt: toolCall.prompt ?? prompt,
    ratio: toolCall.ratio ?? video?.defaultRatio ?? '16:9',
    watermark: toolCall.watermark ?? false,
  }
}

async function generateVideo(
  prompt: string,
  toolCall: Extract<MoyuanToolCall, { tool: 'video_generation' }>,
  options: RuntimeRunOptions,
  skills: EnterpriseSkillSet,
  onStatus: (content: string) => void,
): Promise<VideoGenerationResult> {
  const authToken = options.enterpriseAuthToken
  const baseUrl = options.enterpriseApiBase ?? enterpriseApiBase
  const video = skills.videoGeneration
  if (!authToken) throw new Error('请先登录墨渊账号')
  if (!video?.enabled || !video.apiKeyConfigured) throw new Error('视频生成技能未启用，请管理员在后台配置火山方舟 KEY')

  onStatus('正在调用视频生成技能...')
  const created = (await enterpriseJson('/skills/video/generations', authToken, baseUrl, {
    body: JSON.stringify(buildVideoRequest(toolCall, prompt, skills)),
    method: 'POST',
  })) as { raw?: unknown; status?: string; taskId?: string; videoUrl?: string }

  const taskId = created.taskId ?? findFirstString(created.raw, ['id', 'task_id', 'taskId'])
  if (!taskId) throw new Error('视频生成任务没有返回任务 ID')

  onStatus(`视频任务已创建，正在生成...`)
  let lastStatus = created.status ?? findFirstString(created.raw, ['status'])
  let videoUrl = created.videoUrl ?? findFirstVideoUrl(created.raw)
  const deadline = Date.now() + Number(process.env.VIDEO_TIMEOUT_MS ?? 900000)

  while (!videoUrl && normalizedVideoStatus(lastStatus) === 'running' && Date.now() < deadline) {
    await sleep(Number(process.env.VIDEO_POLL_INTERVAL_MS ?? 6000))
    const queried = (await enterpriseJson(`/skills/video/generations/${encodeURIComponent(taskId)}`, authToken, baseUrl)) as {
      raw?: unknown
      status?: string
      videoUrl?: string
    }
    lastStatus = queried.status ?? findFirstString(queried.raw, ['status'])
    videoUrl = queried.videoUrl ?? findFirstVideoUrl(queried.raw)
    const statusLabel = lastStatus ? `当前状态：${lastStatus}` : '视频仍在生成中'
    onStatus(statusLabel)
    if (normalizedVideoStatus(lastStatus) === 'failed') {
      const message = findFirstString(queried.raw, ['message', 'error', 'msg']) ?? '视频生成失败'
      throw new Error(message)
    }
  }

  if (!videoUrl) throw new Error('视频生成超时，请稍后在历史会话里重试或缩短视频描述')

  return {
    id: taskId,
    prompt,
    model: toolCall.model ?? video.defaultModel,
    url: videoUrl,
    duration: toolCall.duration ?? video.defaultDuration,
    ratio: toolCall.ratio ?? video.defaultRatio,
    resolution: video.defaultResolution,
    createdAt: new Date().toISOString(),
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

function pushEvent(record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) {
  const next: CodexTaskEvent = {
    ...event,
    id: `${event.taskId}-${record.events.length + 1}`,
    timestamp: new Date().toISOString(),
  }

  if (next.type === 'thread.started' && next.raw && typeof next.raw === 'object') {
    const threadId = (next.raw as { thread_id?: unknown }).thread_id
    if (typeof threadId === 'string') {
      record.task.sessionId = threadId
    }
  }

  if (!next.content && next.type !== 'thread.started') return

  record.events.push(next)

  if (next.type === 'message_delta') {
    const itemId = rawItemId(next.raw) ?? `assistant-${record.events.length}`
    const existingIndex = record.streamItemIndexes.get(itemId)

    if (existingIndex === undefined) {
      record.streamItemIndexes.set(itemId, record.task.transcript.length)
      record.task.transcript.push({
        role: 'assistant',
        content: next.content,
        timestamp: next.timestamp,
      })
    } else {
      const current = record.task.transcript[existingIndex]
      const content = next.content.startsWith(current.content) ? next.content : `${current.content}${next.content}`
      record.task.transcript[existingIndex] = { ...current, content, timestamp: next.timestamp }
    }
  } else if (next.type === 'message' && next.role === 'assistant') {
    const itemId = rawItemId(next.raw)
    const existingIndex = itemId ? record.streamItemIndexes.get(itemId) : undefined
    if (existingIndex !== undefined) {
      const current = record.task.transcript[existingIndex]
      record.task.transcript[existingIndex] = { ...current, content: next.content, timestamp: next.timestamp }
    } else if (record.task.transcript.at(-1)?.role !== 'assistant' || record.task.transcript.at(-1)?.content !== next.content) {
      record.task.transcript.push({
        role: next.role,
        content: next.content,
        timestamp: next.timestamp,
      })
    }
  } else if (next.content) {
    record.task.transcript.push({
      role: next.role,
      content: next.content,
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
  const item = (raw as { item?: unknown }).item
  if (!item || typeof item !== 'object') return undefined
  const id = (item as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
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

  if (type === 'item.updated' && item?.type === 'agent_message') {
    const content = firstString(item.text, item.delta, obj.delta, obj.text)

    return {
      taskId,
      type: 'message_delta',
      role: 'assistant',
      content,
      raw: payload,
    }
  }

  if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
    return {
      taskId,
      type: 'message',
      role: 'assistant',
      content: item.text,
      raw: payload,
    }
  }

  if ((type === 'item.started' || type === 'item.completed') && item?.type === 'command_execution') {
    if (type === 'item.started') {
      return {
        taskId,
        type: 'tool',
        role: 'tool',
        content: '',
        raw: payload,
      }
    }

    const command = typeof item.command === 'string' ? item.command : ''
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : ''
    const status = typeof item.status === 'string' ? item.status : 'completed'
    const exitCode = typeof item.exit_code === 'number' ? `\nexit ${item.exit_code}` : ''
    const body = output ? `$ ${command}\n${output}${exitCode}` : `$ ${command}\n${status}`

    return {
      taskId,
      type: 'tool',
      role: 'tool',
      content: body,
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
  record.task.status = code === 0 ? 'completed' : 'failed'
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
    content: code === 0 ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
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
  let completed = false
  let failed = false
  let resolveTurn: (() => void) | undefined
  let rejectTurn: ((error: Error) => void) | undefined
  const turnFinished = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })

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
    const params = message.params && typeof message.params === 'object' ? (message.params as Record<string, unknown>) : {}

    if (method === 'item/agentMessage/delta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : `app-delta-${record.events.length}`
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (!delta) return
      pushEvent(record, {
        taskId,
        type: 'message_delta',
        role: 'assistant',
        content: delta,
        raw: appServerRaw(itemId),
      })
      return
    }

    if (method === 'item/completed') {
      const item = params.item && typeof params.item === 'object' ? (params.item as Record<string, unknown>) : null
      const itemId = typeof item?.id === 'string' ? item.id : `app-item-${record.events.length}`
      if (item?.type === 'agentMessage' && typeof item.text === 'string') {
        const toolCall = parseMoyuanToolCall(item.text)
        if (toolCall) {
          void runMoyuanToolCall(record, toolCall, prompt, options, skills)
          return
        }
        pushEvent(record, {
          taskId,
          type: 'message',
          role: 'assistant',
          content: item.text,
          raw: appServerRaw(itemId),
        })
        return
      }

      if (item?.type === 'commandExecution' && typeof item.command === 'string') {
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.trim() : ''
        const status = typeof item.status === 'string' ? item.status : 'completed'
        const exitCode = typeof item.exitCode === 'number' ? `\nexit ${item.exitCode}` : ''
        const body = output ? `$ ${item.command}\n${output}${exitCode}` : `$ ${item.command}\n${status}`
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

    if (method === 'turn/completed') {
      completed = true
      record.task.status = 'completed'
      pushEvent(record, {
        taskId,
        type: 'turn.completed',
        role: 'system',
        content: '任务完成',
      })
      resolveTurn?.()
      return
    }

    if (method === 'error') {
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
            void runMoyuanToolCall(record, toolCall, prompt, options, skills)
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
      record.task.status = code === 0 ? 'completed' : 'failed'
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
        content: code === 0 ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
      })
    })()
  })
}

async function runImageGeneration(record: TaskRecord, prompt: string, size: string, model?: string) {
  try {
    record.task.status = 'running'
    record.task.updatedAt = new Date().toISOString()
    await saveStore()

    const image = await generateImage(prompt, size, model)
    record.task.status = 'completed'
    record.task.generatedImages = [...(record.task.generatedImages ?? []), image]
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: `![${prompt}](${image.url})`,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.completed',
      role: 'system',
      content: '图片生成完成',
    })
  } catch (error) {
    record.task.status = 'failed'
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.failed',
      role: 'system',
      content: `图片生成失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    await saveStore()
  }
}

async function runVideoGeneration(
  record: TaskRecord,
  prompt: string,
  toolCall: Extract<MoyuanToolCall, { tool: 'video_generation' }>,
  options: RuntimeRunOptions,
  skills: EnterpriseSkillSet,
) {
  try {
    record.task.status = 'running'
    record.task.updatedAt = new Date().toISOString()
    await saveStore()

    const video = await generateVideo(prompt, toolCall, options, skills, (content) => {
      pushEvent(record, {
        taskId: record.task.id,
        type: 'tool',
        role: 'tool',
        content,
      })
    })
    record.task.status = 'completed'
    record.task.generatedVideos = [...(record.task.generatedVideos ?? []), video]
    pushEvent(record, {
      taskId: record.task.id,
      type: 'message',
      role: 'assistant',
      content: `![${prompt}](${video.url})`,
    })
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.completed',
      role: 'system',
      content: '视频生成完成',
    })
  } catch (error) {
    record.task.status = 'failed'
    pushEvent(record, {
      taskId: record.task.id,
      type: 'turn.failed',
      role: 'system',
      content: `视频生成失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    await saveStore()
  }
}

async function runMoyuanToolCall(record: TaskRecord, toolCall: MoyuanToolCall, prompt: string, options: RuntimeRunOptions, skills: EnterpriseSkillSet) {
  if (toolCall.tool === 'image_generation') {
    await runImageGeneration(record, toolCall.prompt ?? prompt, toolCall.size ?? inferImageSize(toolCall.prompt ?? prompt), toolCall.model)
    return
  }

  await runVideoGeneration(record, toolCall.prompt ?? prompt, toolCall, options, skills)
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
  void runImageGeneration(record, parsed.data.prompt, parsed.data.size, parsed.data.model)

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
