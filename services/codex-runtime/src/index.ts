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
  isRuntimeFailureNotice,
  runtimeFailureDiagnostic,
  type CodexTask,
  type CodexTaskEvent,
} from '@eaw/shared'
import { defaultEnterpriseApiBase as enterpriseApiBase, getModelConfig } from './config.js'
import { enterpriseJson, loadEnterpriseRuntimeConfig, validateEnterpriseQuota } from './enterprise/client.js'
import { buildSkillInstructionBlock, isLikelyToolCallFragment, parseMoyuanToolCall } from './skills/contracts.js'
import type { RuntimeRunOptions } from './skills/contracts.js'
import { runImageGenerationTool, runMoyuanToolCall } from './skills/executor.js'
import { createRuntimeLogger } from './observability/logger.js'
import {
  canReuseLifecycleSession,
  finishTaskLifecycle,
  hasFinalAssistantReply,
  hydrateTaskLifecycle,
  resetTaskLifecycleForNewTurn,
  setTaskLifecyclePhase,
} from './tasks/lifecycle.js'
import { sanitizeTask } from './tasks/sanitize.js'
import { approvalSchema, forkSchema, imageGenerationSchema, taskSchema } from './tasks/schemas.js'
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
  await failCodexTask(
    record,
    taskId,
    `失败诊断：${name}没有返回真实资源。Codex 大脑没有输出可执行的结构化技能调用，或者技能执行器没有拿到资产结果；本轮不能把文字“已生成”当作成功。`,
  )
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

function canReuseParentTask(record: TaskRecord) {
  return canReuseLifecycleSession(record, isRuntimeFailureContent) && !latestTurnHasFailure(record.task)
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
    content: record.task.status === 'completed' ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
  })
}

async function failCodexTask(record: TaskRecord, taskId: string, message: string, code: number | null = null) {
  record.cancel = undefined
  record.task.exitCode = code
  setTaskLifecyclePhase(record, 'failed', isRuntimeFailureContent, message)
  logTask(record, 'task.fail', { code, message }, 'error')
  await saveStore()
  pushEvent(record, {
    taskId,
    type: 'turn.failed',
    role: 'system',
    content: isRuntimeFailureContent(message) ? runtimeFailureDiagnostic(message) : friendlyRuntimeMessage(message),
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
  const skillInstructions = buildSkillInstructionBlock(skills)
  const port = await findOpenPort()
  const appServerUrl = `ws://127.0.0.1:${port}`
  const memory = workspaceMemory.get(workspace)
  const diffSummary = await getGitDiff(workspace)
  const baseInstructions = buildBaseInstructions(skillInstructions)
  const promptWithContext = buildPromptWithContext(prompt, {
    commandHistory: record.task.commandHistory,
    diffSummary,
    memory,
    skillInstructions,
  })

  setTaskLifecyclePhase(record, 'running', isRuntimeFailureContent)
  await saveStore()
  logTask(record, 'codex.app_server.start', {
    hasMemory: Boolean(memory),
    model: config.defaultModel,
    port,
    promptLength: prompt.length,
    providerId: config.providerId,
    resume: Boolean(sessionId),
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

  const child = spawn(nodeHostPath, [codexBin, 'app-server', '--listen', appServerUrl, '--disable', 'remote_plugin', '--disable', 'plugin_sharing'], {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: config.apiKey ?? process.env.AI_API_KEY ?? '',
      RUST_LOG: process.env.CODEX_RUST_LOG ?? 'warn',
    },
  })
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

  child.stderr.on('data', (chunk: Buffer) => {
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
          sandbox: 'workspace-write',
          baseInstructions,
          persistExtendedHistory: false,
        }, 45000)
      : await connection.request('thread/start', {
          cwd: workspace,
          model: config.defaultModel,
          runtimeWorkspaceRoots: [workspace],
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
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
      sandboxPolicy: appServerSandboxPolicy(workspace),
      model: config.defaultModel,
    }, 60000)
    activeTurnId = appServerTurnId(turnResult) ?? ''
    logTask(record, 'codex.turn.started', { turnId: activeTurnId })
    await turnFinished
    await Promise.allSettled(pendingUsageReports)
    await Promise.allSettled(pendingToolRuns)
    flushBufferedAssistantItems()
    if (requiredSkill && !hasGeneratedAssetForSkill(record, requiredSkill)) {
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
  const diffSummary = await getGitDiff(workspace)
  const promptWithContext = buildPromptWithContext(prompt, {
    commandHistory: record.task.commandHistory,
    diffSummary,
    memory,
    skillInstructions,
  })
  const args = sessionId
    ? [codexBin, 'exec', 'resume', ...commonArgs, sessionId, promptWithContext]
    : [codexBin, 'exec', ...commonArgs, '--sandbox', 'workspace-write', '-C', workspace, promptWithContext]

  setTaskLifecyclePhase(record, 'running', isRuntimeFailureContent)
  logTask(record, 'codex.exec.start', {
    model: config.defaultModel,
    promptLength: prompt.length,
    providerId: config.providerId,
    resume: Boolean(sessionId),
    transport: 'exec',
  })

  const child = spawn(nodeHostPath, args, {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: config.apiKey ?? process.env.AI_API_KEY ?? '',
      RUST_LOG: process.env.CODEX_RUST_LOG ?? 'warn',
    },
  })
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

  const queueUsageReport = (payload: unknown) => {
    if (usageReported) return
    if (!codexUsageFromPayload(payload)) return
    usageReported = true
    pendingUsageReports.push(reportCodexUsage(taskId, payload, options).catch((error) => app.log.warn({ error }, 'failed to report codex usage')))
  }

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

  child.stderr.on('data', (chunk: Buffer) => {
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
      if (requiredSkill && !hasGeneratedAssetForSkill(record, requiredSkill)) {
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
        content: record.task.status === 'completed' ? 'Codex 任务已完成' : `Codex 任务退出，代码 ${code ?? 'unknown'}`,
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
  taskRecords.forEach(reconcileTaskBeforeResponse)
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

  reconcileTaskBeforeResponse(record)
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
  record.cancelRequested = true
  await failCodexTask(record, params.taskId, message)

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
