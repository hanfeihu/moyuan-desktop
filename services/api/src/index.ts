import cors from '@fastify/cors'
import 'dotenv/config'
import Fastify from 'fastify'
import { z } from 'zod'
import type { Employee, EnterprisePolicy, ModelProviderConfig } from '@eaw/shared'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

const modelConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  enabled: z.boolean(),
})

const employees: Employee[] = [
  { id: 'u-1001', name: '韩飞虎', department: '销售一组', title: '客户经理', source: 'wecom', manager: '王敏' },
  { id: 'u-1002', name: '林青', department: '交付中心', title: '实施顾问', source: 'lark', manager: '赵远' },
  { id: 'u-1003', name: '周然', department: '产品部', title: '产品经理', source: 'dingtalk', manager: '陈立' },
]

let modelProvider: ModelProviderConfig = {
  id: 'blector',
  name: 'Blector 中转',
  baseUrl: process.env.AI_BASE_URL ?? 'https://ai.blector.com/v1',
  maskedApiKey: maskKey(process.env.AI_API_KEY),
  defaultModel: process.env.AI_MODEL ?? 'gpt-5-codex',
  enabled: true,
}

const policy: EnterprisePolicy = {
  dataBoundary: 'local',
  auditEnabled: true,
  externalSharing: 'approval',
  highRiskToolMode: 'approval',
}

function maskKey(key: string | undefined) {
  if (!key) return '未配置'
  if (key.length <= 12) return '已配置'
  return `${key.slice(0, 6)}************************${key.slice(-4)}`
}

app.get('/health', async () => ({
  ok: true,
  service: 'enterprise-api',
}))

app.get('/api/admin/model-provider', async () => ({ data: modelProvider }))

app.put('/api/admin/model-provider', async (request, reply) => {
  const parsed = modelConfigSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '模型配置不完整', detail: parsed.error.flatten() })
  }

  modelProvider = {
    id: 'blector',
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    maskedApiKey: maskKey(parsed.data.apiKey),
    defaultModel: parsed.data.defaultModel,
    enabled: parsed.data.enabled,
  }

  return { data: modelProvider }
})

app.get('/api/admin/employees', async () => ({
  data: employees,
  sources: ['企业微信', '飞书', '钉钉'],
}))

app.get('/api/admin/policy', async () => ({ data: policy }))

app.get('/api/desktop/bootstrap', async () => ({
  data: {
    employee: employees[0],
    policy,
    runtime: {
      codexRuntimeUrl: process.env.CODEX_RUNTIME_URL ?? 'http://localhost:4100',
      modelProvider: {
        name: modelProvider.name,
        baseUrl: modelProvider.baseUrl,
        defaultModel: modelProvider.defaultModel,
        enabled: modelProvider.enabled,
      },
    },
  },
}))

const port = Number(process.env.API_PORT ?? 4000)
const host = process.env.API_HOST ?? '0.0.0.0'
await app.listen({ host, port })
