import cors from '@fastify/cors'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import type { CodexTask } from '@eaw/shared'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

const taskSchema = z.object({
  prompt: z.string().min(1),
  workspace: z.string().default('default'),
  employeeId: z.string().min(1),
})

const approvalSchema = z.object({
  taskId: z.string(),
  decision: z.enum(['allow_once', 'deny']),
  reason: z.string().optional(),
})

const tasks = new Map<string, CodexTask>()

function getModelConfig() {
  return {
    baseUrl: process.env.AI_BASE_URL ?? 'https://ai.blector.com/v1',
    apiKeyConfigured: Boolean(process.env.AI_API_KEY),
    defaultModel: process.env.AI_MODEL ?? 'gpt-5-codex',
  }
}

app.get('/health', async () => ({
  ok: true,
  service: 'codex-runtime',
  codexPackage: '@openai/codex',
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
    status: 'needs_approval',
    workspace: parsed.data.workspace,
    transcript: [
      {
        role: 'user',
        content: parsed.data.prompt,
        timestamp: now,
      },
      {
        role: 'system',
        content: `使用 ${getModelConfig().baseUrl} 作为模型中转。高风险工具调用进入企业审批流。`,
        timestamp: now,
      },
      {
        role: 'assistant',
        content:
          'Codex runtime 已接收任务。正式执行时会启动内置 @openai/codex，并把工具调用、文件访问、命令执行写入审计流。',
        timestamp: now,
      },
    ],
  }

  tasks.set(task.id, task)
  return { data: task }
})

app.get('/api/codex/tasks', async () => ({
  data: Array.from(tasks.values()),
}))

app.post('/api/codex/approvals', async (request, reply) => {
  const parsed = approvalSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '审批参数不完整', detail: parsed.error.flatten() })
  }

  const task = tasks.get(parsed.data.taskId)

  if (!task) {
    return reply.status(404).send({ error: '任务不存在' })
  }

  task.status = parsed.data.decision === 'allow_once' ? 'running' : 'failed'
  task.transcript.push({
    role: 'system',
    content: parsed.data.decision === 'allow_once' ? '员工允许本次工具调用。' : `员工拒绝工具调用：${parsed.data.reason ?? '未填写原因'}`,
    timestamp: new Date().toISOString(),
  })

  return { data: task }
})

const port = Number(process.env.CODEX_RUNTIME_PORT ?? 4100)
await app.listen({ host: '0.0.0.0', port })
