import cors from '@fastify/cors'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'

const app = Fastify({ logger: true })
const require = createRequire(import.meta.url)

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
})

const approvalSchema = z.object({
  taskId: z.string(),
  decision: z.enum(['allow_once', 'deny']),
  reason: z.string().optional(),
})

const records = new Map<string, TaskRecord>()
const mutedStderrPatterns = [
  'failed to warm featured plugin ids cache',
  'startup remote plugin sync failed',
  'skipping startup remote plugin sync',
  'chatgpt authentication required to sync remote plugins',
  'invalid_grant: Invalid refresh token',
  'failed to initialize MCP client during shutdown',
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

async function createCodexHome(taskId: string) {
  const config = getModelConfig()
  const codexHome = path.join(process.env.MOYUAN_CODEX_HOME ?? path.join(tmpdir(), 'moyuan-codex'), taskId)

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

  record.events.push(next)
  record.task.transcript.push({
    role: next.role,
    content: next.content,
    timestamp: next.timestamp,
  })

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
    const command = typeof item.command === 'string' ? item.command : ''
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output.trim() : ''
    const status = typeof item.status === 'string' ? item.status : type === 'item.started' ? 'in_progress' : 'completed'
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
    return { taskId, type, role: 'system', content: type, raw: payload }
  }

  return {
    taskId,
    type: 'message',
    role: 'assistant',
    content: message || JSON.stringify(payload),
    raw: payload,
  }
}

async function runCodex(record: TaskRecord, prompt: string, workspace: string) {
  const taskId = record.task.id
  const codexHome = await createCodexHome(taskId)
  const codexBin = resolveCodexBin()
  const config = getModelConfig()
  const args = [
    codexBin,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--disable',
    'remote_plugin',
    '--disable',
    'plugin_sharing',
    '--sandbox',
    'workspace-write',
    '-c',
    'approval_policy="never"',
    '-m',
    config.defaultModel,
    '-C',
    workspace,
    prompt,
  ]

  record.task.status = 'running'
  pushEvent(record, {
    taskId,
    type: 'turn.started',
    role: 'system',
    content: `启动内置 Codex Runtime，工作区：${workspace}`,
  })

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
      if (line.includes('Reading additional input from stdin')) continue
      if (mutedStderrPatterns.some((pattern) => line.includes(pattern))) continue
      try {
        pushEvent(record, eventFromJson(taskId, JSON.parse(line)))
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

app.post('/api/codex/tasks', async (request, reply) => {
  const parsed = taskSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '任务参数不完整', detail: parsed.error.flatten() })
  }

  const now = new Date().toISOString()
  const task: CodexTask = {
    id: `codex-${Date.now()}`,
    title: parsed.data.prompt.slice(0, 36),
    status: 'queued',
    workspace: parsed.data.workspace,
    createdAt: now,
    exitCode: null,
    transcript: [
      {
        role: 'user',
        content: parsed.data.prompt,
        timestamp: now,
      },
    ],
  }

  const record: TaskRecord = { task, events: [], subscribers: new Set() }
  records.set(task.id, record)
  void runCodex(record, parsed.data.prompt, parsed.data.workspace).catch((error: unknown) => {
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
