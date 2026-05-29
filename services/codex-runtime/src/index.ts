import cors from '@fastify/cors'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import {
  friendlyRuntimeMessage,
  hasLegacyInteractiveVideoPluginFields,
  hasSeedanceInteractiveVideoPluginFields,
  interactiveVideoPluginInputFields,
  isRuntimeFailureNotice,
  runtimeFailureDiagnostic,
  type CodexTask,
  type CodexTaskEvent,
  type PluginDefinition,
  type RuntimePluginInputRequest,
} from '@eaw/shared'
import { defaultEnterpriseApiBase as enterpriseApiBase, getModelConfig } from './config.js'
import { enterpriseJson, loadEnterpriseRuntimeConfig, validateEnterpriseQuota } from './enterprise/client.js'
import { buildSkillInstructionBlock, isLikelyToolCallFragment, parseMoyuanPluginInputCall, parseMoyuanToolCall } from './skills/contracts.js'
import type { MoyuanPluginInputCall, MoyuanToolCall, RuntimeRunOptions } from './skills/contracts.js'
import { runImageGenerationTool, runMoyuanToolCall } from './skills/executor.js'
import { queryVideoGeneration } from './skills/video.js'
import { createRuntimeLogger } from './observability/logger.js'
import {
  finishTaskLifecycle,
  hasFinalAssistantReply,
  hydrateTaskLifecycle,
  resetTaskLifecycleForNewTurn,
  setTaskLifecyclePhase,
} from './tasks/lifecycle.js'
import { sanitizeTask } from './tasks/sanitize.js'
import { approvalSchema, forkSchema, imageGenerationSchema, pluginInputSubmissionSchema, taskSchema } from './tasks/schemas.js'
import { appServerRaw, createTaskEventBus, rawItemId } from './tasks/events.js'
import { registerDiagnosticsRoutes } from './routes/diagnostics.js'
import { appServerSandboxPolicy, appServerThreadId, appServerTurnId, connectAppServer, findOpenPort } from './codex/app-server.js'
import { buildBaseInstructions, buildPromptWithContext } from './codex/context.js'
import {
  assistantDeltaFromParams,
  assistantTextFromItem,
  codexUsageFromPayload,
  eventFromJson,
  firstString,
  isAgentMessageItem,
  isCommandExecutionItem,
  runtimeItemFromCodexItem,
  runtimePlanFromPayload,
  textFromContent,
  usageReportId,
} from './codex/protocol.js'
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
  bodyLimit: 80 * 1024 * 1024,
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
const nodeHostPath = process.env.MOYUAN_NODE_HOST_PATH || process.execPath
const codexSandboxMode = process.env.MOYUAN_CODEX_SANDBOX_MODE ?? 'danger-full-access'
const codexReasoningEffort = process.env.MOYUAN_CODEX_REASONING_EFFORT ?? 'high'

function effectiveSandboxMode(options?: RuntimeRunOptions) {
  return options?.sandboxMode ?? codexSandboxMode
}

function effectiveReasoningEffort(options?: RuntimeRunOptions) {
  return options?.reasoningEffort ?? codexReasoningEffort
}

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

const records = new Map<string, TaskRecord>()
const runtimeRoot = process.env.MOYUAN_RUNTIME_HOME ?? path.join(tmpdir(), 'moyuan-runtime')
const storePath = path.join(runtimeRoot, 'sessions.json')
const memoryPath = path.join(runtimeRoot, 'workspace-memory.json')
const runtimeLogger = createRuntimeLogger(runtimeRoot)
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

const maxVisibleToolOutput = 6000

function logRuntime(event: string, details?: unknown, level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  void runtimeLogger.append({ details, event, level, source: 'codex-runtime' })
}

function logTask(
  record: TaskRecord,
  event: string,
  details?: unknown,
  level: 'debug' | 'info' | 'warn' | 'error' = 'info',
) {
  void runtimeLogger.append(
    {
      details,
      event,
      level,
      sessionId: record.task.sessionId,
      source: 'codex-runtime',
      taskId: record.task.id,
      workspace: record.task.workspace,
    },
    'runtime',
  )
}

function previewLogContent(content: string, maxLength = 240) {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength)}...`
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  const headLength = Math.floor(maxLength * 0.65)
  const tailLength = Math.max(0, maxLength - headLength - 80)
  return `${value.slice(0, headLength)}\n\n... 输出过长，已截断 ${value.length - headLength - tailLength} 个字符 ...\n\n${value.slice(-tailLength)}`
}

function isRuntimeFailureContent(content: string) {
  const text = content.trim()
  if (!text || text.startsWith('$ ')) return false
  return isRuntimeFailureNotice(text)
}

function userVisibleFailureMessage(message: string) {
  if (/Codex app-server|Codex Runtime|ECONNREFUSED|本地 Codex 内核|子进程|spawn|ENOENT|连接失败|连接超时|已断开|退出/i.test(message)) {
    return '本地 Codex 连接中断，已停止。可以重新发送；详细原因已写入本地日志。'
  }
  if (/OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|模型服务暂时不可用/i.test(message)) {
    return '模型服务暂时不可用，已停止。请检查后台模型配置后重试。'
  }
  if (/timeout|timed out|超时|模型响应超时/i.test(message)) {
    return '模型响应超时，已停止。可以缩小任务范围或稍后重试。'
  }
  return friendlyRuntimeMessage(message)
}

function taskUpdatedAtMs(task: CodexTask) {
  return new Date(task.updatedAt ?? task.createdAt ?? 0).getTime()
}

function reconcileTaskBeforeResponse(record: TaskRecord) {
  if (record.task.status !== 'queued' && record.task.status !== 'running') return
  if (record.task.id.startsWith('image-') || record.task.id.startsWith('video-')) return
  if (record.cancel || record.cancelRequested) return
  if (Date.now() - taskUpdatedAtMs(record.task) < 8000) return

  setTaskLifecyclePhase(record, 'failed', isRuntimeFailureContent, '本地任务状态丢失')
  pushEvent(record, {
    taskId: record.task.id,
    type: 'turn.failed',
    role: 'system',
    content: '失败诊断：本地任务状态丢失。Runtime 没有可管理的 Codex 子进程或连接，任务已停止，可以重新发送。',
  })
}

function latestTurnTranscript(task: CodexTask) {
  const lastUserIndex = task.transcript.map((item) => item.role).lastIndexOf('user')
  return lastUserIndex >= 0 ? task.transcript.slice(lastUserIndex) : task.transcript
}

function latestTurnHasFailure(task: CodexTask) {
  return latestTurnTranscript(task).some((item) => {
    if (item.role !== 'system') return false
    const content = item.content.trim()
    return content.startsWith('失败诊断：') || /^Codex\s*任务退出，代码/.test(content) || isRuntimeFailureContent(content)
  })
}

function requestedSkillFromPrompt(prompt: string) {
  const text = prompt.trim()
  if (/(怎么|如何|方案|架构|逻辑|设计|接入|集成|配置|开发|修复|bug|问题|为什么|可行性|思路)/i.test(text)) return undefined
  const imageIntent =
    /(生成|画|绘制|制作|做|出|创建).{0,16}(图片|图像|插画|海报|封面|头像|logo|照片|图)/i.test(text) ||
    /(图片|图像|插画|海报|封面|头像|logo|照片|图).{0,16}(生成|画|绘制|制作|做|出|创建)/i.test(text)
  if (imageIntent) return 'image_generation'

  const videoIntent =
    /(生成|制作|做|创建|出).{0,16}(视频|短片|影片|动画|动图)/i.test(text) ||
    /(视频|短片|影片|动画|动图).{0,16}(生成|制作|做|创建|出)/i.test(text)
  if (videoIntent) return 'video_generation'

  return undefined
}

function hasGeneratedAssetForSkill(record: TaskRecord, skill: ReturnType<typeof requestedSkillFromPrompt>) {
  if (skill === 'image_generation') return Boolean(record.task.generatedImages?.length)
  if (skill === 'video_generation') return Boolean(record.task.generatedVideos?.length)
  return true
}

async function failMissingSkillResult(record: TaskRecord, taskId: string, skill: ReturnType<typeof requestedSkillFromPrompt>) {
  const name = skill === 'image_generation' ? '图片生成' : skill === 'video_generation' ? '视频生成' : '技能'
  const toolName = skill === 'image_generation' ? 'image_generation' : skill === 'video_generation' ? 'video_generation' : '结构化技能'
  await failCodexTask(
    record,
    taskId,
    `失败诊断：${name}没有开始执行。Runtime 没有收到 ${toolName} 调用，所以没有创建资源任务，也没有生成链接。本轮不能把文字回复当作成品。`,
  )
}

function missingSkillRepairPrompt(skill: ReturnType<typeof requestedSkillFromPrompt>, prompt: string) {
  const toolName = skill === 'image_generation' ? 'image_generation' : 'video_generation'
  const assetName = skill === 'image_generation' ? '图片' : '视频'
  return [
    `上一轮用户明确要求生成${assetName}成品，但你没有输出可执行的 ${toolName} JSON，Runtime 因此没有创建资源任务。`,
    `现在请修正编排：只输出一行 ${toolName} JSON，不要解释、不要道歉、不要描述“已生成”。`,
    `用户原始需求：${prompt}`,
  ].join('\n')
}

function queueMissingSkillRepair(record: TaskRecord, taskId: string, skill: ReturnType<typeof requestedSkillFromPrompt>, prompt: string, workspace: string, sessionId: string | undefined, options: RuntimeRunOptions) {
  if (!skill || options.skillRepairAttempt) return false
  setTaskLifecyclePhase(record, 'running', isRuntimeFailureContent, '修正技能编排')
  pushEvent(record, {
    taskId,
    type: 'message',
    role: 'system',
    content: '正在重新发起资源生成调用...',
  })
  void saveStore()
  setTimeout(() => {
    void runCodex(record, missingSkillRepairPrompt(skill, prompt), workspace, record.task.sessionId ?? sessionId, {
      ...options,
      skillRepairAttempt: true,
    }).catch((error: unknown) => {
      if (record.cancelRequested) return
      logTask(record, 'task.skill_repair.failed', error, 'error')
      void failCodexTask(record, taskId, error instanceof Error ? error.message : String(error))
    })
  }, 0).unref()
  return true
}

async function waitForFinalAssistantAfterTurn(record: TaskRecord, timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (hasFinalAssistantReply(record, isRuntimeFailureContent)) return true
    if (record.task.status === 'failed' || record.cancelRequested) return false
    await sleep(250)
  }
  return hasFinalAssistantReply(record, isRuntimeFailureContent)
}

function findRuntimePlugin(plugins: PluginDefinition[] | undefined, call: MoyuanPluginInputCall) {
  const id = call.pluginId.toLowerCase()
  return plugins?.find((plugin) => {
    if (!plugin.enabled || plugin.status !== 'ready') return false
    return plugin.id.toLowerCase() === id || plugin.name.toLowerCase() === id || plugin.triggerHints.some((hint) => hint.toLowerCase() === id)
  })
}

function textFromVideoToolContent(content: unknown[] | undefined) {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const value = 'text' in item ? (item as { text?: unknown }).text : undefined
      return typeof value === 'string' ? value : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || undefined
}

function pluginForTool(plugins: PluginDefinition[] | undefined, tool: MoyuanToolCall['tool']) {
  return plugins?.find((plugin) => {
    if (!plugin.enabled || plugin.status !== 'ready') return false
    if (plugin.interactionMode !== 'requires_user_input') return false
    if (plugin.triggerPolicy !== 'before_tool') return false
    return plugin.targetTools?.some((targetTool) => targetTool === tool)
  })
}

function toolPrefillValues(toolCall: MoyuanToolCall, prompt: string) {
  const values: Record<string, unknown> = {
    model: toolCall.model,
    prompt: toolCall.prompt ?? prompt,
  }
  if (toolCall.tool === 'image_generation') {
    values.size = toolCall.size
  }
  if (toolCall.tool === 'video_generation') {
    values.duration = toolCall.duration
    values.generateAudio = toolCall.generateAudio ?? true
    values.prompt = toolCall.prompt ?? textFromVideoToolContent(toolCall.content) ?? prompt
    values.ratio = toolCall.ratio
  }
  for (const key of Object.keys(values)) {
    if (values[key] === undefined || values[key] === '') delete values[key]
  }
  return values
}

function pluginRequestFromTool(plugin: PluginDefinition, toolCall: MoyuanToolCall, prompt: string): MoyuanPluginInputCall {
  return {
    pluginId: plugin.id,
    title: plugin.name,
    reason: plugin.description || '继续执行前需要补充表单参数。',
    values: toolPrefillValues(toolCall, prompt),
  }
}

function shouldRequestPluginBeforeTool(record: TaskRecord, prompt: string, skills: { plugins?: PluginDefinition[] }, toolCall: MoyuanToolCall) {
  if (!pluginForTool(skills.plugins, toolCall.tool)) return false
  if (record.awaitingPluginInput) return false
  if (prompt.includes('员工已经提交插件表单')) return false
  return true
}

function requestPluginBeforeTool(record: TaskRecord, prompt: string, skills: { plugins?: PluginDefinition[] }, toolCall: MoyuanToolCall) {
  if (!shouldRequestPluginBeforeTool(record, prompt, skills, toolCall)) return false
  const plugin = pluginForTool(skills.plugins, toolCall.tool)
  if (!plugin) return false
  const pluginCall = pluginRequestFromTool(plugin, toolCall, prompt)
  logTask(record, 'plugin.before_tool.requested', {
    pluginId: plugin.id,
    targetTool: toolCall.tool,
    triggerPolicy: plugin.triggerPolicy,
  })
  requestPluginInput(record, plugin, pluginCall)
  return true
}

function requestPluginInput(record: TaskRecord, plugin: PluginDefinition, call: MoyuanPluginInputCall) {
  const now = new Date().toISOString()
  const request: RuntimePluginInputRequest = {
    id: `plugin-${record.task.id}-${Date.now()}`,
    pluginId: plugin.id,
    title: call.title?.trim() || `${plugin.name}需要补充信息`,
    status: 'pending',
    turnId: record.currentTurnId,
    fields: plugin.inputFields,
    values: call.values,
    createdAt: now,
  }

  pushEvent(record, {
    taskId: record.task.id,
    type: 'plugin.inputRequested',
    role: 'system',
    content: call.reason?.trim() || request.title,
    pluginRequest: request,
    item: {
      id: `item-${request.id}`,
      type: 'plugin',
      title: request.title,
      status: 'pending',
      turnId: record.currentTurnId,
      metadata: {
        pluginId: plugin.id,
        pluginName: plugin.name,
      },
      startedAt: now,
    },
    source: {
      id: `source-${request.id}`,
      type: 'plugin',
      title: plugin.name,
      metadata: { pluginId: plugin.id },
      createdAt: now,
    },
  })
  record.awaitingPluginInput = true
}

function cloneInteractiveVideoPluginFields() {
  return interactiveVideoPluginInputFields.map((field) => ({
    ...field,
    options: field.options ? [...field.options] : undefined,
  }))
}

function valueArray(value: unknown) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === '') return []
  return [value]
}

function migrateLegacyInteractiveVideoValues(values?: Record<string, unknown>) {
  const next = { ...(values ?? {}) }
  if (!next.firstFrame && next.referenceImage) next.firstFrame = next.referenceImage

  const referenceImages = [
    ...valueArray(next.referenceImages),
    ...valueArray(next.referenceImage1),
    ...valueArray(next.referenceImage2),
  ]
  if (!next.referenceImages && referenceImages.length) next.referenceImages = referenceImages

  const referenceVideos = [
    ...valueArray(next.referenceVideos),
    ...valueArray(next.referenceVideo),
    ...valueArray(next.referenceVideo1),
  ]
  if (!next.referenceVideos && referenceVideos.length) next.referenceVideos = referenceVideos

  const referenceAudios = [
    ...valueArray(next.referenceAudios),
    ...valueArray(next.referenceAudio1),
  ]
  if (!next.referenceAudios && referenceAudios.length) next.referenceAudios = referenceAudios

  return next
}

function migratePendingInteractiveVideoPluginRequests(task: CodexTask) {
  let changed = false
  const requests = task.pluginRequests?.map((request) => {
    if (request.pluginId !== 'interactive-video-request' || request.status !== 'pending') return request
    if (hasSeedanceInteractiveVideoPluginFields(request.fields) && !hasLegacyInteractiveVideoPluginFields(request.fields)) return request
    changed = true
    return {
      ...request,
      fields: cloneInteractiveVideoPluginFields(),
      values: migrateLegacyInteractiveVideoValues(request.values),
    }
  })
  if (!changed || !requests) return false
  task.pluginRequests = requests
  task.updatedAt = new Date().toISOString()
  return true
}

type PluginAssetValue = {
  dataUrl?: unknown
  name?: unknown
  role?: unknown
  size?: unknown
  type?: unknown
  url?: unknown
}

function pluginAssetRole(fieldId: string, _index = 0) {
  if (fieldId === 'firstFrame') return 'first_frame'
  if (fieldId === 'lastFrame') return 'last_frame'
  if (fieldId.startsWith('referenceImage')) return 'reference_image'
  if (fieldId.startsWith('referenceVideo')) return 'reference_video'
  if (fieldId.startsWith('referenceAudio')) return 'reference_audio'
  if (/image/i.test(fieldId)) return 'reference_image'
  if (/video/i.test(fieldId)) return 'reference_video'
  if (/audio/i.test(fieldId)) return 'reference_audio'
  return 'reference_asset'
}

function pluginAssetContentType(role: string) {
  if (role === 'reference_video') return 'video_url'
  if (role === 'reference_audio') return 'audio_url'
  return 'image_url'
}

function isPluginAssetValue(value: unknown): value is PluginAssetValue {
  return Boolean(value && typeof value === 'object' && ('dataUrl' in value || 'url' in value || 'name' in value))
}

async function uploadPluginAsset(value: PluginAssetValue, options: RuntimeRunOptions) {
  if (typeof value.url === 'string' && value.url) return value.url
  if (typeof value.dataUrl !== 'string' || !value.dataUrl) return undefined
  if (!options.enterpriseAuthToken) throw new Error('请先登录墨渊账号')
  const uploaded = (await enterpriseJson('/plugin-assets', options.enterpriseAuthToken, options.enterpriseApiBase ?? enterpriseApiBase, {
    body: JSON.stringify({
      dataUrl: value.dataUrl,
      name: typeof value.name === 'string' ? value.name : undefined,
      type: typeof value.type === 'string' ? value.type : undefined,
    }),
    method: 'POST',
    timeoutMs: 60000,
  })) as { url?: string }
  return uploaded.url
}

async function normalizePluginSubmittedValues(pluginRequest: RuntimePluginInputRequest, values: Record<string, unknown>, options: RuntimeRunOptions) {
  const normalized: Record<string, unknown> = {}
  for (const field of pluginRequest.fields) {
    const value = values[field.id]
    if (Array.isArray(value)) {
      normalized[field.id] = await Promise.all(value.map(async (item, index) => {
        if (!isPluginAssetValue(item)) return item
        const url = await uploadPluginAsset(item, options)
        return {
          name: typeof item.name === 'string' ? item.name : undefined,
          role: pluginAssetRole(field.id, index),
          size: typeof item.size === 'number' ? item.size : undefined,
          type: typeof item.type === 'string' ? item.type : undefined,
          url,
        }
      }))
      continue
    }
    if (!isPluginAssetValue(value)) {
      normalized[field.id] = value
      continue
    }
    const url = await uploadPluginAsset(value, options)
    normalized[field.id] = {
      name: typeof value.name === 'string' ? value.name : undefined,
      role: pluginAssetRole(field.id),
      size: typeof value.size === 'number' ? value.size : undefined,
      type: typeof value.type === 'string' ? value.type : undefined,
      url,
    }
  }
  return normalized
}

function buildSeedanceContent(values: Record<string, unknown>) {
  const content: unknown[] = []
  const textParts = [
    values.subjectDefinitions ? `主体定义：\n${String(values.subjectDefinitions)}` : '',
    values.prompt ? `核心创意：\n${String(values.prompt)}` : '',
    values.shotList ? `分镜时序：\n${String(values.shotList)}` : '',
    values.visualStyle ? `画质与风格：\n${String(values.visualStyle)}` : '',
    values.constraints ? `约束条件：\n${String(values.constraints)}` : '',
  ].filter(Boolean)
  if (textParts.length) content.push({ type: 'text', text: textParts.join('\n\n') })

  for (const [fieldId, value] of Object.entries(values)) {
    const items = Array.isArray(value) ? value : [value]
    items.forEach((item, index) => {
      if (!isPluginAssetValue(item) || typeof item.url !== 'string' || !item.url) return
      const role = typeof item.role === 'string' ? item.role : pluginAssetRole(fieldId, index)
      const contentType = pluginAssetContentType(role)
      content.push({
        type: contentType,
        [contentType]: { url: item.url },
        role,
      })
    })
  }
  return content
}

function pluginValueLabel(value: unknown): string {
  if (Array.isArray(value)) {
    if (!value.length) return '未填写'
    return value.map((item, index) => `${index + 1}. ${pluginValueLabel(item)}`).join('\n')
  }
  if (isPluginAssetValue(value)) {
    const name = typeof value.name === 'string' ? value.name : '已上传素材'
    const type = typeof value.type === 'string' ? ` (${value.type})` : ''
    const size = typeof value.size === 'number' ? `, ${value.size} bytes` : ''
    const url = typeof value.url === 'string' ? `, URL: ${value.url}` : ''
    const role = typeof value.role === 'string' ? `, role: ${value.role}` : ''
    return `${name}${type}${size}${role}${url}`
  }
  return value === undefined || value === '' ? '未填写' : JSON.stringify(value)
}

async function pluginSubmissionPrompt(pluginRequest: RuntimePluginInputRequest, values: Record<string, unknown>, options: RuntimeRunOptions) {
  const normalizedValues = await normalizePluginSubmittedValues(pluginRequest, values, options)
  const lines = pluginRequest.fields.map((field) => `- ${field.label}: ${pluginValueLabel(normalizedValues[field.id])}`)
  const seedanceContent = buildSeedanceContent(normalizedValues)

  return [
    `员工已经提交插件表单：${pluginRequest.title}`,
    `插件 ID：${pluginRequest.pluginId}`,
    '表单内容：',
    ...lines,
    '',
    'Seedance 2.0 编排要求：',
    '- 你需要根据表单内容组织 video_generation 工具调用；不要把表单当作最终结果。',
    '- 多模态参考：用“参考图片N/视频N/音频N中的主体、动作、运镜、风格或音色，生成...”表述。',
    '- 编辑视频：直接说“严格编辑视频N”，不要写“参考视频N”，未提及部分默认保持不变。',
    '- 延长视频：直接说“向前/向后延长视频N”，保持音视频风格、主体和叙事一致。',
    '- 主体要明确绑定素材，例如“主角@图片1”；复杂视频优先按镜头1、镜头2、镜头3组织。',
    '- 避免无意义堆满素材；文本+音频、纯音频输入不支持，音频应与图片或视频素材组合使用。',
    '- 输出工具 JSON 时，素材数组应使用 image_url/video_url/audio_url，并按需要设置 role 为 first_frame、last_frame、reference_image、reference_video、reference_audio。',
    seedanceContent.length ? `建议 content：${JSON.stringify(seedanceContent)}` : '',
    '',
    `建议参数：${JSON.stringify({
      duration: normalizedValues.duration,
      generate_audio: normalizedValues.generateAudio,
      ratio: normalizedValues.ratio,
      resolution: normalizedValues.resolution,
      taskType: normalizedValues.taskType,
      watermark: normalizedValues.watermark,
    })}`,
    '',
    '请基于这些输入继续完成原任务；如果需要调用技能或继续执行，请直接编排下一步。',
  ].filter(Boolean).join('\n')
}

function canReuseParentTask(record: TaskRecord) {
  if (record.task.status === 'queued' || record.task.status === 'running' || record.cancel) return false
  return true
}

function safeVisibleToolContent(content: string) {
  if (!content.startsWith('$ ')) return truncateMiddle(content, maxVisibleToolOutput)
  const firstLineEnd = content.indexOf('\n')
  if (firstLineEnd < 0) return content
  const command = content.slice(0, firstLineEnd)
  const output = content.slice(firstLineEnd + 1)
  return `${command}\n${truncateMiddle(output, maxVisibleToolOutput)}`
}

function persistedTask(task: CodexTask): CodexTask {
  ensureTaskTranscriptModel(task)
  return {
    ...task,
    transcript: task.transcript
      .filter((item) => item.content.trim())
      .map((item) => ({
        ...item,
        content: item.role === 'tool' ? safeVisibleToolContent(item.content) : item.content,
      })),
  }
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function videoResourceContext(task: CodexTask) {
  const videoItems = (task.items ?? []).filter((item) => item.type === 'video_generation').slice(-4)
  const outputs = (task.outputs ?? []).filter((output) => output.type === 'video').slice(-3)
  const lines = [
    ...videoItems.map((item) => {
      const metadata = item.metadata
      const providerTaskId = metadataString(metadata, 'providerTaskId')
      const rawStatus = metadataString(metadata, 'rawStatus')
      const lastCheckedAt = metadataString(metadata, 'lastCheckedAt')
      const detail = [providerTaskId ? `平台任务 ID：${providerTaskId}` : '', rawStatus ? `平台状态：${rawStatus}` : '', lastCheckedAt ? `最近查询：${lastCheckedAt}` : '']
        .filter(Boolean)
        .join('，')
      return `- ${item.title}：${item.status}${item.content ? `，${item.content}` : ''}${detail ? `（${detail}）` : ''}`
    }),
    ...outputs.map((output) => `- 已有视频结果：${output.title}${output.url ? ` ${output.url}` : ''}`),
  ]
  return lines.join('\n')
}

async function recoverPendingVideoJobs(record: TaskRecord, options: RuntimeRunOptions) {
  const pendingItems = (record.task.items ?? []).filter((item) => {
    if (item.type !== 'video_generation' || item.status !== 'in_progress') return false
    return Boolean(metadataString(item.metadata, 'providerTaskId'))
  })
  if (!pendingItems.length || !options.enterpriseAuthToken) return videoResourceContext(record.task)

  for (const item of pendingItems) {
    const metadata = item.metadata
    const providerTaskId = metadataString(metadata, 'providerTaskId')
    if (!providerTaskId) continue
    const existingOutput = (record.task.outputs ?? []).some((output) => output.type === 'video' && (output.taskItemId === item.id || output.id === `video-${providerTaskId}`))
    if (existingOutput) continue

    try {
      const result = await queryVideoGeneration(providerTaskId, options, {
        createdAt: item.startedAt,
        duration: metadataNumber(metadata, 'duration'),
        model: metadataString(metadata, 'model'),
        prompt: metadataString(metadata, 'prompt') ?? record.task.title,
        ratio: metadataString(metadata, 'ratio'),
        resolution: metadataString(metadata, 'resolution'),
      })
      const now = new Date().toISOString()
      if (result.video) {
        record.task.generatedVideos = [...(record.task.generatedVideos ?? []).filter((video) => video.id !== result.video!.id), result.video]
        pushEvent(record, {
          taskId: record.task.id,
          type: 'item.completed',
          role: 'system',
          content: '',
          itemId: item.id,
          item: {
            ...item,
            status: 'completed',
            content: '视频生成完成',
            completedAt: now,
            metadata: { ...(item.metadata ?? {}), lastCheckedAt: now, providerTaskId, rawStatus: result.status, url: result.video.url },
          },
        })
        pushEvent(record, {
          taskId: record.task.id,
          type: 'output.added',
          role: 'system',
          content: '',
          output: {
            id: `video-${result.video.id}`,
            type: 'video',
            title: '生成视频',
            url: result.video.url,
            taskItemId: item.id,
            metadata: { duration: result.video.duration, model: result.video.model, prompt: result.video.prompt, ratio: result.video.ratio, resolution: result.video.resolution, usageTokens: result.video.usageTokens },
            createdAt: result.video.createdAt,
          },
          source: {
            id: `skill-video-${result.video.id}`,
            type: 'skill',
            title: '视频生成技能',
            metadata: { model: result.video.model },
            createdAt: result.video.createdAt,
          },
        })
        continue
      }

      const failed = result.status === 'failed'
      pushEvent(record, {
        taskId: record.task.id,
        type: failed ? 'item.completed' : 'item.delta',
        role: 'system',
        content: '',
        itemId: item.id,
        item: {
          ...item,
          status: failed ? 'failed' : 'in_progress',
          content: failed ? result.error ?? '视频生成失败' : `视频仍在生成中${result.status ? `：${result.status}` : ''}`,
          completedAt: failed ? now : undefined,
          metadata: { ...(item.metadata ?? {}), lastCheckedAt: now, providerTaskId, rawStatus: result.status, usageTokens: result.usageTokens },
        },
      })
    } catch (error) {
      logTask(record, 'video.recover.failed', { itemId: item.id, providerTaskId, error: error instanceof Error ? error.message : String(error) }, 'warn')
    }
  }

  await saveStore()
  return videoResourceContext(record.task)
}

function ensureTaskTranscriptModel(task: CodexTask) {
  let turnIndex = 0
  let currentTurnId = `${task.id}-turn-1`
  let maxSeq = 0

  task.transcript.forEach((item, index) => {
    if (item.role === 'user') {
      turnIndex += 1
      currentTurnId = item.turnId ?? `${task.id}-turn-${turnIndex}`
    } else if (turnIndex === 0) {
      turnIndex = 1
      currentTurnId = item.turnId ?? `${task.id}-turn-1`
    }

    item.turnId ??= currentTurnId
    if (typeof item.seq !== 'number') item.seq = index + 1
    maxSeq = Math.max(maxSeq, item.seq)
  })

  return {
    currentTurnId,
    nextTranscriptSeq: maxSeq + 1,
  }
}

function hydrateRecordTranscriptState(record: TaskRecord) {
  const state = ensureTaskTranscriptModel(record.task)
  record.currentTurnId ??= state.currentTurnId
  record.nextTranscriptSeq ??= state.nextTranscriptSeq
}

function startTaskTurn(record: TaskRecord, now: string) {
  hydrateRecordTranscriptState(record)
  const nextTurnIndex = record.task.transcript.filter((item) => item.role === 'user').length + 1
  record.currentTurnId = `${record.task.id}-turn-${nextTurnIndex}`
  record.activeAssistantItemId = undefined
  record.awaitingPluginInput = false
  record.streamItemIndexes.clear()
  resetTaskLifecycleForNewTurn(record, now)
}

function appendTranscriptItem(
  record: TaskRecord,
  item: Omit<CodexTask['transcript'][number], 'seq' | 'turnId'> & Partial<Pick<CodexTask['transcript'][number], 'seq' | 'turnId'>>,
) {
  hydrateRecordTranscriptState(record)
  const nextItem = {
    ...item,
    seq: item.seq ?? record.nextTranscriptSeq ?? 1,
    turnId: item.turnId ?? record.currentTurnId ?? `${record.task.id}-turn-1`,
  }
  record.nextTranscriptSeq = nextItem.seq + 1
  record.task.transcript.push(nextItem)
  return nextItem
}

const { eventSequence, pushEvent, streamAssistantMessage } = createTaskEventBus({
  appendTranscriptItem,
  isRuntimeFailureContent,
  logTask,
  saveStore,
  safeVisibleToolContent,
})

function resolveCodexBin() {
  return require.resolve('@openai/codex/bin/codex.js')
}

async function saveStore() {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    storePath,
    JSON.stringify({ tasks: Array.from(records.values()).map((record) => persistedTask(record.task)) }, null, 2),
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
      const restored = persistedTask(task)
      migratePendingInteractiveVideoPluginRequests(restored)
      if (restored.status === 'queued' || restored.status === 'running') {
        restored.status = 'failed'
        restored.updatedAt = new Date().toISOString()
        restored.transcript.push({
          role: 'system',
          content: '上次本地 Runtime 重启，这个任务已中断，可以重新发送。',
          timestamp: restored.updatedAt,
        })
      }
      const transcriptState = ensureTaskTranscriptModel(restored)
      records.set(restored.id, {
        task: restored,
        events: [],
        lifecycle: hydrateTaskLifecycle(restored, isRuntimeFailureContent),
        currentTurnId: transcriptState.currentTurnId,
        nextTranscriptSeq: transcriptState.nextTranscriptSeq,
        subscribers: new Set(),
        streamItemIndexes: new Map(),
      })
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

async function ensureWorkspace(workspace: string) {
  const fallbackWorkspace = process.env.MOYUAN_DEFAULT_WORKSPACE ?? path.join(runtimeRoot, 'workspace')
  const target = workspace.trim() || fallbackWorkspace
  await mkdir(target, { recursive: true })
  return target
}

async function createCodexHome(config = getModelConfig()) {
  const codexHome = process.env.MOYUAN_CODEX_HOME ?? path.join(tmpdir(), 'moyuan-codex', 'default')
  const sandboxMode = codexSandboxMode
  const reasoningEffort = codexReasoningEffort

  await mkdir(codexHome, { recursive: true })
  await writeFile(
    path.join(codexHome, 'config.toml'),
    [
      `model_provider = "${config.providerId}"`,
      `model = "${config.defaultModel}"`,
      'approval_policy = "never"',
      `sandbox_mode = "${sandboxMode}"`,
      `model_reasoning_effort = "${reasoningEffort}"`,
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

async function reportCodexUsage(taskId: string, payload: unknown, options: RuntimeRunOptions) {
  if (!options.enterpriseAuthToken) return
  const usage = codexUsageFromPayload(payload)
  if (!usage) return
  await enterpriseJson('/me/usage', options.enterpriseAuthToken, options.enterpriseApiBase ?? enterpriseApiBase, {
    body: JSON.stringify({
      ...usage,
      reportId: usageReportId(taskId, payload),
      taskId,
    }),
    method: 'POST',
  })
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

function childProcessOptions(workspace: string, codexHome: string, apiKey: string, stdio: ['ignore', 'ignore' | 'pipe', 'pipe']) {
  return {
    cwd: workspace,
    detached: process.platform !== 'win32',
    stdio,
    windowsHide: true,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      ELECTRON_RUN_AS_NODE: '1',
      OPENAI_API_KEY: apiKey,
      RUST_LOG: process.env.CODEX_RUST_LOG ?? 'warn',
    },
  } satisfies Parameters<typeof spawn>[2]
}

async function finishCodexTask(record: TaskRecord, taskId: string, code: number | null) {
  record.cancel = undefined
  const lifecycle = finishTaskLifecycle(record, code, isRuntimeFailureContent)
  logTask(record, 'task.finish', {
    assistantEvents: lifecycle.assistantEvents,
    code,
    finalAssistantEvents: lifecycle.finalAssistantEvents,
    phase: lifecycle.phase,
    reason: lifecycle.reason,
    toolEvents: lifecycle.toolEvents,
  }, lifecycle.phase === 'failed' ? 'warn' : 'info')
  if (lifecycle.phase === 'failed' && lifecycle.reason?.includes('没有返回最终回复') && !latestTurnHasFailure(record.task)) {
    pushEvent(record, {
      taskId,
      type: 'turn.failed',
      role: 'system',
      content: '失败诊断：Codex 已结束本轮工具执行，但没有返回最终回复。任务已停止，可以重新发送；如果连续出现，需要检查 app-server 的 turn.completed 与 assistant message 事件。',
    })
  }
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
    content:
      record.task.status === 'needs_approval'
        ? '等待插件表单提交'
        : record.task.status === 'completed'
          ? 'Codex 任务已完成'
          : record.task.status === 'interrupted'
            ? 'Codex 任务已停止'
            : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
  })
}

async function interruptCodexTask(record: TaskRecord, taskId: string, message: string, code: number | null = null) {
  record.cancel = undefined
  record.cancelRequested = true
  record.task.exitCode = code
  setTaskLifecyclePhase(record, 'interrupted', isRuntimeFailureContent, message)
  logTask(record, 'task.interrupt', { code, message }, 'warn')
  await saveStore()
  pushEvent(record, {
    taskId,
    type: 'turn.interrupted',
    role: 'system',
    content: message,
  })
}

async function failCodexTask(record: TaskRecord, taskId: string, message: string, code: number | null = null) {
  record.cancel = undefined
  record.task.exitCode = code
  setTaskLifecyclePhase(record, 'failed', isRuntimeFailureContent, message)
  logTask(record, 'task.fail', { code, diagnostic: runtimeFailureDiagnostic(message), message }, 'error')
  await saveStore()
  pushEvent(record, {
    taskId,
    type: 'turn.failed',
    role: 'system',
    content: userVisibleFailureMessage(message),
  })
}

async function runCodexAppServer(record: TaskRecord, prompt: string, workspace: string, sessionId: string | undefined, options: RuntimeRunOptions) {
  const taskId = record.task.id
  workspace = await ensureWorkspace(workspace)
  record.task.workspace = workspace
  const requiredSkill = requestedSkillFromPrompt(prompt)
  const codexBin = resolveCodexBin()
  const { modelConfig: config, skills } = await loadEnterpriseRuntimeConfig(options.enterpriseAuthToken, options.enterpriseApiBase)
  const codexHome = await createCodexHome(config)
  const sandboxMode = effectiveSandboxMode(options)
  const reasoningEffort = effectiveReasoningEffort(options)
  const skillInstructions = buildSkillInstructionBlock(skills)
  const port = await findOpenPort()
  const appServerUrl = `ws://127.0.0.1:${port}`
  const memory = workspaceMemory.get(workspace)
  const diffSummary = await getGitDiff(workspace)
  const resourceContext = await recoverPendingVideoJobs(record, options)
  const baseInstructions = buildBaseInstructions(skillInstructions)
  const promptWithContext = buildPromptWithContext(prompt, {
    commandHistory: record.task.commandHistory,
    diffSummary,
    memory,
    resourceContext,
    skillInstructions,
  })

  setTaskLifecyclePhase(record, 'running', isRuntimeFailureContent)
  await saveStore()
  logTask(record, 'codex.app_server.start', {
    hasMemory: Boolean(memory),
    model: config.defaultModel,
    port,
    plugins: (skills.plugins ?? []).map((plugin) => ({
      id: plugin.id,
      status: plugin.status,
      targetTools: plugin.targetTools ?? [],
      triggerPolicy: plugin.triggerPolicy ?? 'manual',
    })),
    promptLength: prompt.length,
    providerId: config.providerId,
    reasoningEffort,
    resume: Boolean(sessionId),
    sandboxMode,
    transport: 'app-server',
  })

  let activeTurnId = ''
  let fallbackAssistantItemId = ''
  let completed = false
  let failed = false
  let lastActivityAt = Date.now()
  let idleWarningSent = false
  let resolveTurn: (() => void) | undefined
  let rejectTurn: ((error: Error) => void) | undefined
  const turnFinished = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve
    rejectTurn = reject
  })
  const assistantDeltaBuffers = new Map<string, string>()
  const pendingToolRuns: Promise<void>[] = []
  const pendingUsageReports: Promise<void>[] = []
  let usageReported = false

  const queueUsageReport = (payload: unknown) => {
    if (usageReported) return
    if (!codexUsageFromPayload(payload)) return
    usageReported = true
    pendingUsageReports.push(reportCodexUsage(taskId, payload, options).catch((error) => app.log.warn({ error }, 'failed to report codex usage')))
  }

  const startToolRun = (toolCall: ReturnType<typeof parseMoyuanToolCall>) => {
    if (!toolCall) return false
    if (requestPluginBeforeTool(record, prompt, skills, toolCall)) return true
    const toolRun = runMoyuanToolCall({ record, toolCall, prompt, options, skills, runtimeRoot, saveStore, pushEvent })
    pendingToolRuns.push(toolRun)
    void toolRun
    return true
  }

  const startPluginInputRequest = (pluginCall: ReturnType<typeof parseMoyuanPluginInputCall>) => {
    if (!pluginCall) return false
    const plugin = findRuntimePlugin(skills.plugins, pluginCall)
    if (!plugin) return false
    requestPluginInput(record, plugin, pluginCall)
    return true
  }

  const flushBufferedAssistantItems = () => {
    for (const [itemId, content] of Array.from(assistantDeltaBuffers.entries())) {
      const toolCall = parseMoyuanToolCall(content)
      assistantDeltaBuffers.delete(itemId)
      if (startToolRun(toolCall)) continue
      if (startPluginInputRequest(parseMoyuanPluginInputCall(content))) continue
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

  const childEnv = childProcessOptions(workspace, codexHome, config.apiKey ?? process.env.AI_API_KEY ?? '', ['ignore', 'ignore', 'pipe'])
  const child = spawn(nodeHostPath, [codexBin, 'app-server', '--listen', appServerUrl, '--disable', 'remote_plugin', '--disable', 'plugin_sharing'], childEnv)
  logTask(record, 'codex.app_server.spawned', { nodeHostPath, pid: child.pid, port })
  record.cancel = (reason = '已停止本次任务。') => {
    if (record.cancelRequested) return
    record.cancelRequested = true
    failed = true
    logTask(record, 'task.cancel.requested', { reason }, 'warn')
    rejectTurn?.(new Error(reason))
    terminateProcessTree(child)
  }

  const watchdog = setInterval(() => {
    if (completed || failed || record.cancelRequested) return
    const idleMs = Date.now() - lastActivityAt
    if (!idleWarningSent && idleMs > 45000) {
      idleWarningSent = true
      pushEvent(record, {
        taskId,
        type: 'message',
        role: 'system',
        content: '等待模型响应超过 45 秒，可以继续等，也可以手动停止后重试。',
      })
      return
    }
    if (idleMs > 5 * 60 * 1000) {
      failed = true
      rejectTurn?.(new Error('模型响应超时，任务已停止。'))
    }
  }, 5000)
  watchdog.unref()

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (!text) return
    if (mutedStderrPatterns.some((pattern) => text.includes(pattern))) return
    app.log.debug({ text }, 'codex app-server stderr')
    logTask(record, 'codex.stderr', { text }, 'warn')
  })

  child.once('error', (error) => {
    failed = true
    logTask(record, 'codex.app_server.spawn_error', { message: error.message, nodeHostPath }, 'error')
    rejectTurn?.(new Error(`Codex 子进程启动失败：${error.message}`))
  })

  child.once('exit', (code) => {
    logTask(record, 'codex.app_server.exit', { code, completed, failed, cancelRequested: Boolean(record.cancelRequested) }, code === 0 ? 'info' : 'warn')
    if (record.cancelRequested) return
    if (!completed && !failed) {
      rejectTurn?.(new Error(`Codex app-server 退出，代码 ${code ?? 'unknown'}`))
    }
  })

  let connection: Awaited<ReturnType<typeof connectAppServer>> | undefined

  try {
    connection = await connectAppServer(appServerUrl, (message) => {
      lastActivityAt = Date.now()
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

      if (methodKey === 'turnplanupdated') {
        pushEvent(record, {
          taskId,
          type: 'plan.updated',
          role: 'system',
          content: '',
          plan: runtimePlanFromPayload(params),
          raw: message,
        })
        return
      }

      if (methodKey === 'itemstarted' && item) {
        pushEvent(record, {
          taskId,
          type: 'item.started',
          role: isCommandExecutionItem(item) ? 'tool' : 'system',
          content: '',
          item: runtimeItemFromCodexItem(item, 'item.started'),
          itemId,
          raw: message,
        })
        return
      }

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
          const output = truncateMiddle(firstString(commandItem.aggregatedOutput, commandItem.aggregated_output, commandItem.output).trim(), maxVisibleToolOutput)
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
            item: runtimeItemFromCodexItem(commandItem, 'item.completed'),
            itemId,
            raw: { item: { id: itemId, type: 'command_execution' } },
          })
        }
        return
      }

      if (methodKey === 'turncompleted') {
        completed = true
        setTaskLifecyclePhase(record, 'waiting_final', isRuntimeFailureContent)
        queueUsageReport(params)
        flushBufferedAssistantItems()
        pushEvent(record, {
          taskId,
          type: 'turn.completed',
          role: 'system',
          content: '任务完成',
          turnId: activeTurnId,
          raw: message,
        })
        resolveTurn?.()
        return
      }

      if (methodKey === 'error') {
        const willRetry = params.willRetry === true
        if (willRetry) return
        failed = true
        const error = params.error && typeof params.error === 'object' ? (params.error as { message?: unknown }) : {}
        logTask(record, 'codex.app_server.notification_error', { error, params }, 'error')
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
          setTaskLifecyclePhase(record, 'waiting_final', isRuntimeFailureContent)
          queueUsageReport(eventWithItemId.raw)
          flushBufferedAssistantItems()
          resolveTurn?.()
          return
        }
        pushEvent(record, eventWithItemId)
      }
    })
    logTask(record, 'codex.app_server.connected', { port })

    await connection.request('initialize', {
      clientInfo: { name: 'moyuan-desktop', title: 'Moyuan Desktop', version: '0.1.3' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    }, 15000)
    logTask(record, 'codex.app_server.initialized', { model: config.defaultModel })

    const threadResult = sessionId
      ? await connection.request('thread/resume', {
          threadId: sessionId,
          cwd: workspace,
          model: config.defaultModel,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: 'never',
          sandbox: sandboxMode,
          baseInstructions,
          persistExtendedHistory: false,
        }, 45000)
      : await connection.request('thread/start', {
          cwd: workspace,
          model: config.defaultModel,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: 'never',
          sandbox: sandboxMode,
          baseInstructions,
          threadSource: 'user',
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        }, 45000)
    const threadId = appServerThreadId(threadResult)
    if (!threadId) throw new Error('Codex app-server 没有返回会话 id')
    record.task.sessionId = threadId
    logTask(record, sessionId ? 'codex.thread.resumed' : 'codex.thread.started', { threadId })
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
      sandboxPolicy: appServerSandboxPolicy(workspace, sandboxMode),
      model: config.defaultModel,
      effort: reasoningEffort,
    }, 60000)
    activeTurnId = appServerTurnId(turnResult) ?? ''
    logTask(record, 'codex.turn.started', { turnId: activeTurnId })
    pushEvent(record, {
      taskId,
      type: 'turn.started',
      role: 'system',
      content: '',
      turnId: activeTurnId,
      raw: turnResult,
    })
    await turnFinished
    await Promise.allSettled(pendingUsageReports)
    await Promise.allSettled(pendingToolRuns)
    flushBufferedAssistantItems()
    if (requiredSkill && !record.awaitingPluginInput && !hasGeneratedAssetForSkill(record, requiredSkill)) {
      if (queueMissingSkillRepair(record, taskId, requiredSkill, prompt, workspace, sessionId, options)) return
      await failMissingSkillResult(record, taskId, requiredSkill)
      return
    }
    const finalAssistantArrived = await waitForFinalAssistantAfterTurn(record)
    logTask(record, 'codex.turn.final_wait_finished', { finalAssistantArrived, turnId: activeTurnId }, finalAssistantArrived ? 'info' : 'warn')
    await finishCodexTask(record, taskId, 0)
  } catch (error) {
    if (record.cancelRequested) {
      logTask(record, 'codex.run.cancelled', error, 'warn')
      await saveStore()
      return
    }
    logTask(record, 'codex.run.failed', error, 'error')
    await failCodexTask(record, taskId, error instanceof Error ? error.message : String(error))
    return
  } finally {
    clearInterval(watchdog)
    record.cancel = undefined
    connection?.close()
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
  workspace = await ensureWorkspace(workspace)
  record.task.workspace = workspace
  const requiredSkill = requestedSkillFromPrompt(prompt)
  const codexBin = resolveCodexBin()
  const { modelConfig: config, skills } = await loadEnterpriseRuntimeConfig(options.enterpriseAuthToken, options.enterpriseApiBase)
  const codexHome = await createCodexHome(config)
  const sandboxMode = effectiveSandboxMode(options)
  const reasoningEffort = effectiveReasoningEffort(options)
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
    `sandbox_mode="${sandboxMode}"`,
    '-c',
    `model_reasoning_effort="${reasoningEffort}"`,
    '-m',
    config.defaultModel,
  ]
  const memory = workspaceMemory.get(workspace)
  const diffSummary = await getGitDiff(workspace)
  const resourceContext = await recoverPendingVideoJobs(record, options)
  const promptWithContext = buildPromptWithContext(prompt, {
    commandHistory: record.task.commandHistory,
    diffSummary,
    memory,
    resourceContext,
    skillInstructions,
  })
  const args = sessionId
    ? [codexBin, 'exec', 'resume', ...commonArgs, sessionId, promptWithContext]
    : [codexBin, 'exec', ...commonArgs, '--sandbox', sandboxMode, '-C', workspace, promptWithContext]

  setTaskLifecyclePhase(record, 'running', isRuntimeFailureContent)
  logTask(record, 'codex.exec.start', {
    model: config.defaultModel,
    plugins: (skills.plugins ?? []).map((plugin) => ({
      id: plugin.id,
      status: plugin.status,
      targetTools: plugin.targetTools ?? [],
      triggerPolicy: plugin.triggerPolicy ?? 'manual',
    })),
    promptLength: prompt.length,
    providerId: config.providerId,
    reasoningEffort,
    resume: Boolean(sessionId),
    sandboxMode,
    transport: 'exec',
  })

  const childEnv = childProcessOptions(workspace, codexHome, config.apiKey ?? process.env.AI_API_KEY ?? '', ['ignore', 'pipe', 'pipe'])
  const child = spawn(nodeHostPath, args, childEnv)
  logTask(record, 'codex.exec.spawned', { nodeHostPath, pid: child.pid })
  record.cancel = (reason = '已停止本次任务。') => {
    if (record.cancelRequested) return
    record.cancelRequested = true
    void reason
    logTask(record, 'task.cancel.requested', { reason }, 'warn')
    terminateProcessTree(child)
  }

  let buffer = ''
  const pendingAssistantStreams: Promise<void>[] = []
  const pendingToolRuns: Promise<void>[] = []
  const pendingUsageReports: Promise<void>[] = []
  let usageReported = false

  const startPluginInputRequest = (pluginCall: ReturnType<typeof parseMoyuanPluginInputCall>) => {
    if (!pluginCall) return false
    const plugin = findRuntimePlugin(skills.plugins, pluginCall)
    if (!plugin) return false
    requestPluginInput(record, plugin, pluginCall)
    return true
  }

  const queueUsageReport = (payload: unknown) => {
    if (usageReported) return
    if (!codexUsageFromPayload(payload)) return
    usageReported = true
    pendingUsageReports.push(reportCodexUsage(taskId, payload, options).catch((error) => app.log.warn({ error }, 'failed to report codex usage')))
  }

  child.stdout?.on('data', (chunk: Buffer) => {
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
            if (requestPluginBeforeTool(record, prompt, skills, toolCall)) continue
            const toolRun = runMoyuanToolCall({ record, toolCall, prompt, options, skills, runtimeRoot, saveStore, pushEvent })
            pendingToolRuns.push(toolRun)
            void toolRun
            continue
          }
          if (startPluginInputRequest(parseMoyuanPluginInputCall(event.content))) continue
          pendingAssistantStreams.push(streamAssistantMessage(record, event))
          continue
        }
        if (event.type === 'turn.completed') {
          queueUsageReport(event.raw)
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

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim()
    if (!text) return
    if (mutedStderrPatterns.some((pattern) => text.includes(pattern))) return
    logTask(record, 'codex.stderr', { text }, 'warn')
    pushEvent(record, {
      taskId,
      type: 'error',
      role: 'system',
      content: text,
    })
  })

  child.once('error', (error) => {
    logTask(record, 'codex.exec.spawn_error', { message: error.message, nodeHostPath }, 'error')
    record.cancel = undefined
    void failCodexTask(record, taskId, `Codex 子进程启动失败：${error.message}`)
  })

  child.on('exit', (code) => {
    logTask(record, 'codex.exec.exit', { code, cancelRequested: Boolean(record.cancelRequested) }, code === 0 ? 'info' : 'warn')
    record.cancel = undefined
    record.task.exitCode = code
    if (record.cancelRequested) {
      finishTaskLifecycle(record, code, isRuntimeFailureContent)
      void saveStore()
      return
    }
    void (async () => {
      await Promise.allSettled(pendingAssistantStreams)
      await Promise.allSettled(pendingToolRuns)
      await Promise.allSettled(pendingUsageReports)
      if (requiredSkill && !record.awaitingPluginInput && !hasGeneratedAssetForSkill(record, requiredSkill)) {
        if (queueMissingSkillRepair(record, taskId, requiredSkill, prompt, workspace, sessionId, options)) return
        await failMissingSkillResult(record, taskId, requiredSkill)
        return
      }
      const lifecycle = finishTaskLifecycle(record, code, isRuntimeFailureContent)
      if (lifecycle.phase === 'failed' && lifecycle.reason?.includes('没有返回最终回复') && !latestTurnHasFailure(record.task)) {
        pushEvent(record, {
          taskId,
          type: 'turn.failed',
          role: 'system',
          content: '失败诊断：Codex 已结束本轮工具执行，但没有返回最终回复。任务已停止，可以重新发送；如果连续出现，需要检查 app-server 的 turn.completed 与 assistant message 事件。',
        })
      }
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
        content:
          record.task.status === 'needs_approval'
            ? '等待插件表单提交'
            : record.task.status === 'completed'
              ? 'Codex 任务已完成'
              : record.task.status === 'interrupted'
                ? 'Codex 任务已停止'
                : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
      })
    })()
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

registerDiagnosticsRoutes({
  app,
  resolveCodexBin,
  runtimeHost,
  runtimeLogger,
  runtimeToken,
})

logRuntime('runtime.boot', {
  codexBin: resolveCodexBin(),
  host: runtimeHost,
  logs: runtimeLogger.paths,
  protected: Boolean(runtimeToken),
  runtimeRoot,
  storePath,
})
await loadStore()
await saveStore()

app.post('/api/codex/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body)

  if (!parsed.success) {
    logRuntime('task.create.invalid_request', parsed.error.flatten(), 'warn')
    return reply.status(400).send({ error: '任务参数不完整', detail: parsed.error.flatten() })
  }

  const quota = await validateEnterpriseQuota(parsed.data.enterpriseAuthToken, parsed.data.enterpriseApiBase)
  if (!quota.ok) {
    logRuntime(
      'task.create.quota_rejected',
      {
        employeeId: parsed.data.employeeId,
        error: quota.error,
        statusCode: quota.statusCode,
        workspace: parsed.data.workspace,
      },
      'warn',
    )
    return reply.status(quota.statusCode ?? 500).send({ error: quota.error ?? '额度校验失败' })
  }

  const now = new Date().toISOString()
  const existingRecord = parsed.data.parentTaskId ? records.get(parsed.data.parentTaskId) : undefined
  const reusableRecord = existingRecord && canReuseParentTask(existingRecord) ? existingRecord : undefined
  const requestedSessionId = reusableRecord || !parsed.data.parentTaskId ? parsed.data.sessionId : undefined
  const task: CodexTask =
    reusableRecord?.task ?? {
      id: `codex-${Date.now()}`,
      title: parsed.data.prompt.slice(0, 36),
      status: 'queued',
      workspace: parsed.data.workspace,
      sessionId: requestedSessionId,
      createdAt: now,
      updatedAt: now,
      exitCode: null,
      transcript: [],
    }
  const record: TaskRecord = reusableRecord ?? {
    task,
    events: [],
    lifecycle: hydrateTaskLifecycle(task, isRuntimeFailureContent),
    subscribers: new Set(),
    streamItemIndexes: new Map(),
  }
  if (reusableRecord) {
    startTaskTurn(record, now)
  } else {
    hydrateRecordTranscriptState(record)
    record.currentTurnId = `${task.id}-turn-1`
  }

  task.status = 'queued'
  task.workspace = parsed.data.workspace
  task.workspaceMemory = workspaceMemory.get(parsed.data.workspace)
  task.diffSummary = await getGitDiff(parsed.data.workspace)
  task.updatedAt = now
  appendTranscriptItem(record, {
    role: 'user',
    content: parsed.data.prompt,
    timestamp: now,
  })

  record.cancelRequested = false
  record.cancel = undefined
  records.set(task.id, record)
  await saveStore()
  logTask(record, 'task.create.accepted', {
    employeeId: parsed.data.employeeId,
    parentTaskId: parsed.data.parentTaskId,
    promptLength: parsed.data.prompt.length,
    promptPreview: previewLogContent(parsed.data.prompt),
    reusable: Boolean(reusableRecord),
    requestedSessionId,
  })

  void runCodex(record, parsed.data.prompt, parsed.data.workspace, requestedSessionId ?? task.sessionId, {
    enterpriseApiBase: parsed.data.enterpriseApiBase,
    enterpriseAuthToken: parsed.data.enterpriseAuthToken,
    reasoningEffort: parsed.data.reasoningEffort,
    sandboxMode: parsed.data.sandboxMode,
  }).catch((error: unknown) => {
    if (record.cancelRequested) return
    logTask(record, 'task.run.unhandled_error', error, 'error')
    setTaskLifecyclePhase(record, 'failed', isRuntimeFailureContent, error instanceof Error ? error.message : String(error))
    pushEvent(record, {
      taskId: task.id,
      type: 'turn.failed',
      role: 'system',
      content: friendlyRuntimeMessage(error instanceof Error ? error.message : String(error)),
    })
  })

  return { data: task }
})

app.get('/api/codex/tasks', async () => {
  const taskRecords = Array.from(records.values())
  let changed = false
  taskRecords.forEach((record) => {
    changed = migratePendingInteractiveVideoPluginRequests(record.task) || changed
    reconcileTaskBeforeResponse(record)
  })
  if (changed) await saveStore()
  return {
    data: taskRecords.map((record) => sanitizeTask(record.task)),
  }
})

app.post('/api/images/generations', async (request, reply) => {
  const parsed = imageGenerationSchema.safeParse(request.body)

  if (!parsed.success) {
    logRuntime('image.create.invalid_request', parsed.error.flatten(), 'warn')
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
    transcript: [],
  }
  const record: TaskRecord = { task, events: [], lifecycle: hydrateTaskLifecycle(task, isRuntimeFailureContent), subscribers: new Set(), streamItemIndexes: new Map() }
  hydrateRecordTranscriptState(record)
  record.currentTurnId = `${task.id}-turn-1`
  appendTranscriptItem(record, {
    role: 'user',
    content: parsed.data.prompt,
    timestamp: now,
  })
  records.set(task.id, record)
  await saveStore()
  logTask(record, 'image.create.accepted', {
    employeeId: parsed.data.employeeId,
    model: parsed.data.model,
    promptLength: parsed.data.prompt.length,
    promptPreview: previewLogContent(parsed.data.prompt),
    size: parsed.data.size,
  })
  const { skills } = await loadEnterpriseRuntimeConfig(parsed.data.enterpriseAuthToken, parsed.data.enterpriseApiBase)
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

  const changed = migratePendingInteractiveVideoPluginRequests(record.task)
  reconcileTaskBeforeResponse(record)
  if (changed) await saveStore()
  return { data: sanitizeTask(record.task) }
})

app.post('/api/codex/tasks/:taskId/cancel', async (request, reply) => {
  const params = z.object({ taskId: z.string() }).parse(request.params)
  const record = records.get(params.taskId)

  if (!record) {
    logRuntime('task.cancel.not_found', { taskId: params.taskId }, 'warn')
    return reply.status(404).send({ error: '任务不存在' })
  }

  if (record.task.status !== 'queued' && record.task.status !== 'running') {
    logTask(record, 'task.cancel.ignored_terminal', { status: record.task.status }, 'debug')
    return { data: sanitizeTask(record.task) }
  }

  const message = '已停止本次任务。'
  logTask(record, 'task.cancel.accepted', { status: record.task.status }, 'warn')
  record.cancel?.(message)
  await interruptCodexTask(record, params.taskId, message)

  return { data: sanitizeTask(record.task) }
})

app.post('/api/codex/tasks/:taskId/plugin-requests/:requestId/submit', async (request, reply) => {
  const params = z.object({ requestId: z.string(), taskId: z.string() }).parse(request.params)
  const parsed = pluginInputSubmissionSchema.safeParse(request.body ?? {})
  if (!parsed.success) {
    return reply.status(400).send({ error: '插件表单参数不完整', detail: parsed.error.flatten() })
  }

  const record = records.get(params.taskId)
  if (!record) return reply.status(404).send({ error: '任务不存在' })

  migratePendingInteractiveVideoPluginRequests(record.task)
  const pluginRequest = record.task.pluginRequests?.find((item) => item.id === params.requestId)
  if (!pluginRequest) return reply.status(404).send({ error: '插件请求不存在' })
  if (pluginRequest.status !== 'pending') return { data: sanitizeTask(record.task) }

  const now = new Date().toISOString()
  const submittedRequest: RuntimePluginInputRequest = {
    ...pluginRequest,
    status: 'submitted',
    values: parsed.data.values,
    resolvedAt: now,
  }
  let continuationPrompt: string
  try {
    continuationPrompt = await pluginSubmissionPrompt(submittedRequest, parsed.data.values, {
      enterpriseApiBase: parsed.data.enterpriseApiBase,
      enterpriseAuthToken: parsed.data.enterpriseAuthToken,
    })
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : '插件素材处理失败' })
  }
  pushEvent(record, {
    taskId: params.taskId,
    type: 'plugin.inputSubmitted',
    role: 'system',
    content: '员工已提交插件表单。',
    pluginRequest: submittedRequest,
    item: {
      id: pluginRequest.itemId ?? `item-${pluginRequest.id}`,
      type: 'plugin',
      title: pluginRequest.title,
      status: 'completed',
      turnId: pluginRequest.turnId ?? record.currentTurnId,
      metadata: { pluginId: pluginRequest.pluginId },
      completedAt: now,
    },
  })

  record.awaitingPluginInput = false
  startTaskTurn(record, now)
  appendTranscriptItem(record, {
    role: 'user',
    content: continuationPrompt,
    timestamp: now,
  })
  await saveStore()

  void runCodex(record, continuationPrompt, record.task.workspace, record.task.sessionId, {
    enterpriseApiBase: parsed.data.enterpriseApiBase,
    enterpriseAuthToken: parsed.data.enterpriseAuthToken,
  }).catch((error: unknown) => {
    if (record.cancelRequested) return
    logTask(record, 'plugin.continue.unhandled_error', error, 'error')
    setTaskLifecyclePhase(record, 'failed', isRuntimeFailureContent, error instanceof Error ? error.message : String(error))
    pushEvent(record, {
      taskId: params.taskId,
      type: 'turn.failed',
      role: 'system',
      content: friendlyRuntimeMessage(error instanceof Error ? error.message : String(error)),
    })
  })

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

  const record: TaskRecord = { task: forked, events: [], lifecycle: hydrateTaskLifecycle(forked, isRuntimeFailureContent), subscribers: new Set(), streamItemIndexes: new Map() }
  hydrateRecordTranscriptState(record)
  records.set(forked.id, record)
  await saveStore()
  logTask(record, 'task.fork.created', {
    hasPrompt: Boolean(parsed.data.prompt),
    sourceTaskId: params.taskId,
  })

  if (parsed.data.prompt) {
    startTaskTurn(record, now)
    appendTranscriptItem(record, { role: 'user', content: parsed.data.prompt, timestamp: now })
    void runCodex(record, parsed.data.prompt, forked.workspace, forked.sessionId)
  }

  return { data: forked }
})

app.get('/api/codex/tasks/:taskId/events', async (request, reply) => {
  const params = z.object({ taskId: z.string() }).parse(request.params)
  const query = z.object({ after: z.string().optional() }).parse(request.query)
  const record = records.get(params.taskId)

  if (!record) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  reconcileTaskBeforeResponse(record)
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : ''
  const allowOrigin =
    !origin || origin === 'null' || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)
      ? origin || '*'
      : 'http://127.0.0.1:5170'
  reply.hijack()
  reply.raw.writeHead(200, {
    'Access-Control-Allow-Origin': allowOrigin,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Vary: 'Origin',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  })
  reply.raw.write(': connected\n\n')

  const send = (event: CodexTaskEvent) => {
    reply.raw.write(`id: ${event.id}\n`)
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const lastEventId = query.after ?? (typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : undefined)
  const afterSequence = lastEventId ? eventSequence(lastEventId, params.taskId) : undefined
  const replayEvents = afterSequence === undefined ? record.events : record.events.filter((event) => (eventSequence(event.id, params.taskId) ?? 0) > afterSequence)

  for (const event of replayEvents) send(event)

  record.subscribers.add(send)
  logTask(record, 'sse.subscribe', { after: lastEventId, replayed: replayEvents.length, subscribers: record.subscribers.size }, 'debug')
  request.raw.on('close', () => {
    record.subscribers.delete(send)
    logTask(record, 'sse.close', { subscribers: record.subscribers.size }, 'debug')
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
logRuntime('runtime.listen', { host: runtimeHost, port, logs: runtimeLogger.paths })
