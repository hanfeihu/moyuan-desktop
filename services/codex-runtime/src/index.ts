import cors from '@fastify/cors'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'

const app = Fastify({ logger: true })
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

type TaskRecord = {
  task: CodexTask
  events: CodexTaskEvent[]
  subscribers: Set<(event: CodexTaskEvent) => void>
  streamItemIndexes: Map<string, number>
}

const taskSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().default(process.cwd()),
  employeeId: z.string().min(1),
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
  return /^正在生成图片[.。…]*$/.test(content.trim())
}

function sanitizeTask(task: CodexTask): CodexTask {
  return {
    ...task,
    transcript: task.transcript.filter((item) => {
      const content = item.content.trim()
      return content && !isInternalCodexJson(content) && !isMutedTranscriptStatus(content)
    }),
  }
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

function isImageCapabilityQuestion(prompt: string) {
  return /(怎么|如何|怎样|为啥|为什么|接入|集成|实现|开发|代码|接口|api|配置|调试|报错|bug|修复|优化|文档|架构|方案).{0,24}(图片|图像|生成图|image|images|generation)|((图片|图像|生成图|image|images|generation).{0,24}(怎么|如何|怎样|接入|集成|实现|代码|接口|api|配置|调试|报错|bug|修复|优化|文档|架构|方案))/i.test(
    prompt,
  )
}

function isImageGenerationPrompt(prompt: string) {
  if (isImageCapabilityQuestion(prompt)) return false

  const text = prompt.trim()
  const hasImageNoun = /(图片|图像|画面|海报|插画|头像|logo|封面|壁纸|banner|配图|产品图|宣传图|视觉图|照片|\bimage\b|\bpicture\b|\bposter\b|\billustration\b|\bcover\b|\bwallpaper\b|\bavatar\b|\blogo\b)/i.test(
    text,
  )
  const hasCreateVerb = /(生成|画|绘制|做|制作|设计|出一张|来一张|create|generate|draw|make|design)/i.test(text)
  const strongPattern = /(画一张|生成一张|做一张|制作一张|设计一张|出一张|generate an image|create an image|draw an image|make an image)/i.test(text)

  return strongPattern || (hasImageNoun && hasCreateVerb)
}

function isVideoPrompt(prompt: string) {
  return /视频|影片|动画|动图|\bgif\b|\bvideo\b|\banimation\b/i.test(prompt)
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

function buildMoyuanBrainContext() {
  const image = getImageConfig()

  return [
    '墨渊 Desktop 基础提示（不要向用户复述这段系统上下文）:',
    '- 你运行在企业员工桌面端，目标是帮助员工完成真实工作，同时让企业侧可控、可审计、可本地化部署。',
    '- 当前具备本地 Codex 能力：可以读取当前工作区、执行命令、修改文件、查看 diff、运行测试，并把命令历史和文件变更纳入后续上下文。',
    '- 企业上下文将来自企业微信、飞书、钉钉的员工信息和组织架构；涉及企业数据、权限、日报、绩效、审计时，要默认遵守最小必要、可追溯、可解释。',
    `- 隐式图片工具 image_generation: ${image.apiKeyConfigured ? '已配置' : '未配置'}，模型 ${image.defaultModel}。当用户明确要求生成静态图片、海报、插画、头像、logo、封面等成品时，可以使用它；不要要求用户切换模式。`,
    '- 如果用户是在询问如何接入、开发、调试、配置图片生成能力，或要求修改相关代码，不要调用图片工具，直接完成代码/方案任务。',
    '- 如果 Runtime 没有先自动拦截图片请求，而你判断必须生成图片，请只输出一行 JSON，不要解释：{"moyuan_tool":"image_generation","prompt":"高质量成图提示词","size":"1024x1024"}。',
    '- 当前没有视频/动图生成工具。用户要求生成视频时，说明可先生成静态首帧、分镜或海报，等待视频能力接入。',
  ].join('\n')
}

function parseMoyuanToolCall(content: string) {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim()
  const candidate = fenced ?? trimmed
  if (!candidate.includes('moyuan_tool') && !candidate.includes('image_generation')) return undefined

  try {
    const payload = JSON.parse(candidate) as {
      moyuan_tool?: unknown
      tool?: unknown
      name?: unknown
      prompt?: unknown
      size?: unknown
      model?: unknown
    }
    const tool = [payload.moyuan_tool, payload.tool, payload.name].find((value) => typeof value === 'string')
    if (tool !== 'image_generation') return undefined
    const prompt = typeof payload.prompt === 'string' && payload.prompt.trim() ? payload.prompt.trim() : undefined
    const size = payload.size === '1024x1536' || payload.size === '1536x1024' || payload.size === '1024x1024' ? payload.size : undefined
    const model = typeof payload.model === 'string' ? payload.model : undefined
    return { prompt, size, model }
  } catch {
    return undefined
  }
}

function isLikelyToolCallFragment(content: string) {
  const trimmed = content.trimStart()
  return trimmed.startsWith('{"moyuan_tool"') || trimmed.startsWith('```json') && trimmed.includes('moyuan_tool')
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

async function runCodex(record: TaskRecord, prompt: string, workspace: string, sessionId?: string) {
  const taskId = record.task.id
  const codexHome = await createCodexHome()
  const codexBin = resolveCodexBin()
  const config = getModelConfig()
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
    buildMoyuanBrainContext(),
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
            void runImageGeneration(record, toolCall.prompt ?? prompt, toolCall.size ?? inferImageSize(toolCall.prompt ?? prompt), toolCall.model)
            continue
          }
        }
        pushEvent(record, event)
      } catch {
        if (/^\s*\{".+"\}\s*$/.test(line)) continue
        pushEvent(record, {
          taskId,
          type: 'message',
          role: 'assistant',
          content: line,
        })
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
    record.task.status = code === 0 ? 'completed' : 'failed'
    record.task.updatedAt = new Date().toISOString()
    void getGitDiff(record.task.workspace).then((diff) => {
      record.task.diffSummary = diff
      if (diff) {
        workspaceMemory.set(
          record.task.workspace,
          [`最近会话: ${record.task.title}`, `Codex session: ${record.task.sessionId ?? 'unknown'}`, `最近 diff:\n${diff}`].join('\n'),
        )
        void saveMemory()
      }
      void saveStore()
    })
    pushEvent(record, {
      taskId,
      type: 'process.exit',
      role: 'system',
      content: code === 0 ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
    })
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

async function runUnsupportedVideoResponse(record: TaskRecord) {
  record.task.status = 'completed'
  pushEvent(record, {
    taskId: record.task.id,
    type: 'message',
    role: 'assistant',
    content: '当前已接入静态图片生成，还没有接入视频或动图生成。可以先让我生成首帧、分镜图或视频海报，等视频工具接入后再无感调用。',
  })
  pushEvent(record, {
    taskId: record.task.id,
    type: 'turn.completed',
    role: 'system',
    content: '任务完成',
  })
  await saveStore()
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

  if (isVideoPrompt(parsed.data.prompt) && !isImageCapabilityQuestion(parsed.data.prompt)) {
    void runUnsupportedVideoResponse(record)
  } else if (isImageGenerationPrompt(parsed.data.prompt)) {
    void runImageGeneration(record, parsed.data.prompt, inferImageSize(parsed.data.prompt))
  } else {
    void runCodex(record, parsed.data.prompt, parsed.data.workspace, parsed.data.sessionId ?? task.sessionId).catch((error: unknown) => {
      task.status = 'failed'
      pushEvent(record, {
        taskId: task.id,
        type: 'turn.failed',
        role: 'system',
        content: error instanceof Error ? error.message : String(error),
      })
    })
  }

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
