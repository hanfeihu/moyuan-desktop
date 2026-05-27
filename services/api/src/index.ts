import cors from '@fastify/cors'
import 'dotenv/config'
import Fastify from 'fastify'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { Employee, EnterprisePolicy, ModelProviderConfig, VideoSkillConfig } from '@eaw/shared'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })

const modelConfigSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  enabled: z.boolean(),
})

const videoSkillConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  defaultDuration: z.coerce.number().int().min(1).max(30),
  defaultModel: z.string().min(1),
  defaultRatio: z.string().min(1),
  defaultResolution: z.string().min(1),
  allowImageInput: z.boolean(),
  enabled: z.boolean(),
  monthlyLimit: z.coerce.number().int().min(0),
})

type StoredAdminConfig = {
  videoSkillApiKey?: string
  videoSkill?: Omit<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>
}

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

const configFile = process.env.ADMIN_CONFIG_FILE ?? './data/admin-config.json'
let storedConfig = await loadStoredConfig()
let videoSkillApiKey = storedConfig.videoSkillApiKey ?? process.env.VOLCENGINE_ARK_API_KEY ?? ''
let videoSkill: VideoSkillConfig = buildVideoSkillConfig(storedConfig.videoSkill)

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

async function loadStoredConfig(): Promise<StoredAdminConfig> {
  try {
    return JSON.parse(await readFile(configFile, 'utf8')) as StoredAdminConfig
  } catch {
    return {}
  }
}

async function persistStoredConfig() {
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(
    configFile,
    JSON.stringify(
      {
        videoSkill,
        videoSkillApiKey,
      },
      null,
      2,
    ),
  )
}

function buildVideoSkillConfig(stored?: Omit<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>): VideoSkillConfig {
  const apiKeyConfigured = Boolean(videoSkillApiKey)
  return {
    id: stored?.id ?? 'volcengine-seedance',
    name: stored?.name ?? '火山方舟 Seedance 视频生成',
    provider: 'volcengine-ark',
    baseUrl: stored?.baseUrl ?? process.env.VOLCENGINE_ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    maskedApiKey: maskKey(videoSkillApiKey),
    apiKeyConfigured,
    defaultModel: stored?.defaultModel ?? process.env.VOLCENGINE_VIDEO_MODEL ?? 'doubao-seedance-2-0-260128',
    enabled: stored?.enabled ?? apiKeyConfigured,
    allowImageInput: stored?.allowImageInput ?? true,
    defaultDuration: stored?.defaultDuration ?? 5,
    defaultRatio: stored?.defaultRatio ?? '16:9',
    defaultResolution: stored?.defaultResolution ?? '720p',
    monthlyLimit: stored?.monthlyLimit ?? 100,
  }
}

app.get('/health', async () => ({
  ok: true,
  service: 'enterprise-api',
}))

app.get('/api/admin/model-provider', async () => ({ data: modelProvider }))

app.get('/api/admin/video-skill', async () => ({ data: videoSkill }))

app.put('/api/admin/video-skill', async (request, reply) => {
  const parsed = videoSkillConfigSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '视频生成技能配置不完整', detail: parsed.error.flatten() })
  }

  if (parsed.data.apiKey?.trim()) {
    videoSkillApiKey = parsed.data.apiKey.trim()
  }

  if (parsed.data.enabled && !videoSkillApiKey) {
    return reply.status(400).send({ error: '启用视频技能前，请先配置 API Key' })
  }

  videoSkill = {
    id: 'volcengine-seedance',
    name: '火山方舟 Seedance 视频生成',
    provider: 'volcengine-ark',
    baseUrl: parsed.data.baseUrl,
    maskedApiKey: maskKey(videoSkillApiKey),
    apiKeyConfigured: Boolean(videoSkillApiKey),
    defaultModel: parsed.data.defaultModel,
    enabled: parsed.data.enabled,
    allowImageInput: parsed.data.allowImageInput,
    defaultDuration: parsed.data.defaultDuration,
    defaultRatio: parsed.data.defaultRatio,
    defaultResolution: parsed.data.defaultResolution,
    monthlyLimit: parsed.data.monthlyLimit,
  }

  await persistStoredConfig()

  return { data: videoSkill }
})

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
      skills: {
        videoGeneration: {
          allowImageInput: videoSkill.allowImageInput,
          baseUrl: videoSkill.baseUrl,
          defaultDuration: videoSkill.defaultDuration,
          defaultModel: videoSkill.defaultModel,
          defaultRatio: videoSkill.defaultRatio,
          defaultResolution: videoSkill.defaultResolution,
          enabled: videoSkill.enabled,
          apiKeyConfigured: videoSkill.apiKeyConfigured,
          name: videoSkill.name,
          provider: videoSkill.provider,
        },
      },
    },
  },
}))

const port = Number(process.env.API_PORT ?? 4000)
const host = process.env.API_HOST ?? '0.0.0.0'
await app.listen({ host, port })
