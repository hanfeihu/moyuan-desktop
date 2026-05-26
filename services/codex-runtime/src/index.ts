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
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'

const app = Fastify({ logger: true })
const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

await app.register(cors, { origin: true })

type TaskRecord = {
  task: CodexTask
  events: CodexTaskEvent[]
  subscribers: Set<(event: CodexTaskEvent) => void>
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

function resolveCodexBin() {
  return require.resolve('@openai/codex/bin/codex.js')
}

async function saveStore() {
  await mkdir(runtimeRoot, { recursive: true })
  await writeFile(
    storePath,
    JSON.stringify({ tasks: Array.from(records.values()).map((record) => record.task) }, null, 2),
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
      records.set(task.id, { task, events: [], subscribers: new Set() })
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
  if (next.content) {
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

function eventFromJson(taskId: string, payload: unknown): Omit<CodexTaskEvent, 'id' | 'timestamp'> {
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const type = typeof obj.type === 'string' ? obj.type : 'message'
  const message = typeof obj.message === 'string' ? obj.message : ''
  const item = obj.item && typeof obj.item === 'object' ? (obj.item as Record<string, unknown>) : null

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

  if (type.includes('error') || type === 'turn.failed') {
    return {
      taskId,
      type: type === 'turn.failed' ? 'turn.failed' : 'error',
      role: 'system',
      content: message || JSON.stringify(payload),
      raw: payload,
    }
  }

  if (type.includes('exec') || type.includes('tool')) {
    return {
      taskId,
      type: 'tool',
      role: 'tool',
      content: message || JSON.stringify(payload),
      raw: payload,
    }
  }

  if (type === 'turn.completed') {
    return { taskId, type: 'turn.completed', role: 'system', content: '任务完成', raw: payload }
  }

  if (type === 'thread.started' || type === 'turn.started') {
    return { taskId, type, role: 'system', content: '', raw: payload }
  }

  return {
    taskId,
    type: 'message',
    role: 'assistant',
    content: message || JSON.stringify(payload),
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
        pushEvent(record, event)
      } catch {
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

app.get('/health', async () => ({
  ok: true,
  service: 'codex-runtime',
  bundledCodex: true,
  codexBin: resolveCodexBin(),
  model: getModelConfig(),
}))

await loadStore()

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

  const record: TaskRecord = existingRecord ?? { task, events: [], subscribers: new Set() }
  records.set(task.id, record)
  await saveStore()
  void runCodex(record, parsed.data.prompt, parsed.data.workspace, parsed.data.sessionId ?? task.sessionId).catch((error: unknown) => {
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
  data: Array.from(records.values()).map((record) => record.task),
}))

app.get('/api/codex/tasks/:taskId', async (request, reply) => {
  const params = z.object({ taskId: z.string() }).parse(request.params)
  const record = records.get(params.taskId)

  if (!record) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  return { data: record.task }
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

  const record: TaskRecord = { task: forked, events: [], subscribers: new Set() }
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

const port = Number(process.env.CODEX_RUNTIME_PORT ?? 4100)
await app.listen({ host: '0.0.0.0', port })
