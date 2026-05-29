import cors from '@fastify/cors'
import 'dotenv/config'
import Fastify from 'fastify'
import nodemailer from 'nodemailer'
import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import {
  hasLegacyInteractiveVideoPluginFields,
  hasSeedanceInteractiveVideoPluginFields,
  interactiveVideoPluginInputFields,
} from '@eaw/shared'
import type {
  AccountUser,
  ClientLogRecord,
  Employee,
  EnterprisePolicy,
  GeneratedAssetRecord,
  ImageSkillConfig,
  MailServiceConfig,
  ModelProviderConfig,
  PaymentGatewayConfig,
  PluginDefinition,
  VideoRatio,
  VideoResolution,
  RechargeOrder,
  TokenPlan,
  VideoSkillConfig,
} from '@eaw/shared'

const app = Fastify({ bodyLimit: 80 * 1024 * 1024, logger: true })

await app.register(cors, { origin: true })
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
  done(null, Object.fromEntries(new URLSearchParams(String(body))))
})

const videoRatioOptions = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const satisfies readonly VideoRatio[]
const videoResolutionOptions = ['480p', '720p', '1080p'] as const satisfies readonly VideoResolution[]

function defaultVideoRatioForModel(model?: string): VideoRatio {
  const normalized = (model ?? '').toLowerCase().replace(/[_.\s]+/g, '-')
  return normalized.includes('seedance-2') || normalized.includes('seedance-1-5-pro') ? 'adaptive' : '16:9'
}

const modelConfigSchema = z.object({
  id: z.preprocess((value) => (value === '' ? undefined : value), z.string().min(1).optional()),
  name: z.string().min(1),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  defaultModel: z.string().min(1),
  enabled: z.boolean(),
  monthlyLimit: z.coerce.number().int().min(0),
})

const videoSkillConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  defaultDuration: z.coerce.number().int().min(1).max(30),
  defaultModel: z.string().min(1),
  defaultRatio: z.enum(videoRatioOptions),
  defaultResolution: z.enum(videoResolutionOptions),
  allowImageInput: z.boolean(),
  enabled: z.boolean(),
  monthlyLimit: z.coerce.number().int().min(0),
})

const imageSkillConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  defaultModel: z.string().min(1),
  defaultSize: z.enum(['1024x1024', '1024x1536', '1536x1024']),
  enabled: z.boolean(),
  monthlyLimit: z.coerce.number().int().min(0),
})

const pluginIdParamSchema = z.object({
  id: z.string().min(1),
})

const pluginInputFieldSchema = z.object({
  helpText: z.string().optional(),
  id: z.string().min(1),
  label: z.string().min(1),
  maxFiles: z.coerce.number().int().min(1).max(12).optional(),
  placeholder: z.string().optional(),
  type: z.enum(['text', 'textarea', 'select', 'number', 'boolean', 'image', 'video', 'audio', 'file']),
  required: z.boolean().optional(),
  options: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).optional(),
})

const pluginDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.enum(['media', 'data', 'workflow', 'developer', 'custom']),
  handler: z.enum(['runtime', 'server', 'external']),
  interactionMode: z.enum(['automatic', 'requires_user_input']),
  targetTools: z.array(z.string().min(1)).default([]),
  triggerPolicy: z.enum(['manual', 'before_tool']).default('manual'),
  enabled: z.boolean(),
  triggerHints: z.array(z.string().min(1)).default([]),
  inputFields: z.array(pluginInputFieldSchema).default([]),
  permissions: z.array(z.string().min(1)).default([]),
  quotaType: z.enum(['token', 'task', 'asset']),
})

const imageGenerationSchema = z.object({
  async: z.boolean().optional(),
  model: z.string().optional(),
  n: z.coerce.number().int().min(1).max(4).default(1),
  prompt: z.string().min(1),
  size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional(),
})

const clientLogSchema = z.object({
  appVersion: z.string().max(80).optional(),
  details: z.unknown().optional(),
  deviceId: z.string().min(1).max(120),
  deviceName: z.string().max(160).optional(),
  event: z.string().min(1).max(160),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  osVersion: z.string().max(160).optional(),
  platform: z.string().min(1).max(80),
  sessionId: z.string().max(160).optional(),
  source: z.string().min(1).max(80).default('desktop-renderer'),
  taskId: z.string().max(160).optional(),
  timestamp: z.string().optional(),
  userAgent: z.string().max(500).optional(),
  workspace: z.string().max(1000).optional(),
})

const videoGenerationSchema = z
  .object({
    content: z.array(z.unknown()).optional(),
    duration: z.coerce.number().int().min(1).max(30).optional(),
    generate_audio: z.boolean().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    ratio: z.enum(videoRatioOptions).optional(),
    resolution: z.enum(videoResolutionOptions).optional(),
    watermark: z.boolean().optional(),
  })
  .passthrough()

const pluginAssetUploadSchema = z.object({
  dataUrl: z.string().min(1),
  name: z.string().min(1).max(240).optional(),
  type: z.string().min(1).max(120).optional(),
})

const mailConfigSchema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().email(),
  fromName: z.string().min(1),
  authCode: z.string().optional(),
  enabled: z.boolean(),
})

const paymentGatewayConfigSchema = z.object({
  enabled: z.boolean(),
  gatewayUrl: z.string().url(),
  key: z.string().optional(),
  pid: z.string().min(1),
  supportedMethods: z.array(z.enum(['alipay', 'wxpay'])).min(1),
})

const tokenPlanSchema = z.object({
  description: z.string().max(300).optional().default(''),
  enabled: z.boolean(),
  name: z.string().min(1).max(80),
  price: z.coerce.number().positive(),
  sort: z.coerce.number().int().min(0).default(100),
  tokens: z.coerce.number().int().positive(),
})

const rechargeOrderSchema = z.object({
  method: z.enum(['alipay', 'wxpay']).default('alipay'),
  planId: z.string().min(1),
})

const sendCodeSchema = z.object({
  email: z.string().email(),
})

const authSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
  name: z.string().optional(),
})

const adminAuthSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
})

const usageSchema = z.object({
  promptTokens: z.coerce.number().int().min(0).default(0),
  completionTokens: z.coerce.number().int().min(0).default(0),
  skillTokens: z.coerce.number().int().min(0).default(0),
  totalTokens: z.coerce.number().int().min(0).optional(),
  reportId: z.string().optional(),
  taskId: z.string().optional(),
})

const quotaSchema = z.object({
  mode: z.enum(['grant', 'set']).default('grant'),
  amount: z.coerce.number().int().min(0),
})

const userIdParamSchema = z.object({
  id: z.string().min(1),
})

type StoredAdminConfig = {
  adminAuth?: AdminAuthConfig
  adminSessions?: AdminSession[]
  modelProvider?: Omit<ModelProviderConfig, 'maskedApiKey'>
  modelProviders?: Array<Omit<ModelProviderConfig, 'maskedApiKey'>>
  modelProviderApiKeys?: Record<string, string>
  imageSkillApiKey?: string
  imageSkill?: Partial<Omit<ImageSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>> & Partial<Pick<ImageSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>>
  videoSkillApiKey?: string
  videoSkill?: Partial<Omit<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>> & Partial<Pick<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>>
  plugins?: PluginDefinition[]
  mailAuthCode?: string
  mailSettings?: Omit<MailServiceConfig, 'maskedAuthCode' | 'authCodeConfigured'>
  paymentGateway?: Omit<PaymentGatewayConfig, 'maskedKey' | 'keyConfigured'>
  paymentGatewayKey?: string
  rechargeOrders?: RechargeOrder[]
  tokenPlans?: TokenPlan[]
  users?: AccountUser[]
  sessions?: Array<{ tokenHash: string; userId: string; createdAt: string; lastSeenAt: string }>
  videoTaskCharges?: VideoTaskCharge[]
  generatedAssets?: GeneratedAssetRecord[]
  clientLogs?: ClientLogRecord[]
  usageReportIds?: string[]
}

type AdminAuthConfig = {
  username: string
  passwordHash: string
  passwordSalt: string
  updatedAt: string
}

type AdminSession = {
  tokenHash: string
  createdAt: string
  lastSeenAt: string
}

type VideoTaskCharge = {
  taskId: string
  userId: string
  tokens: number
  status: 'completed'
  createdAt: string
  updatedAt: string
}

type ImageGenerationJob = {
  body: {
    model: string
    n: number
    prompt: string
    size: '1024x1024' | '1024x1536' | '1536x1024'
  }
  createdAt: string
  error?: string
  id: string
  result?: {
    raw: unknown
    storageUrl?: string
    usageTokens: number
    user: AccountUser
  }
  status: 'running' | 'succeeded' | 'failed'
  updatedAt: string
  userId: string
}

const employees: Employee[] = [
  { id: 'u-1001', name: '韩飞虎', department: '销售一组', title: '客户经理', source: 'wecom', manager: '王敏' },
  { id: 'u-1002', name: '林青', department: '交付中心', title: '实施顾问', source: 'lark', manager: '赵远' },
  { id: 'u-1003', name: '周然', department: '产品部', title: '产品经理', source: 'dingtalk', manager: '陈立' },
]

const configFile = process.env.ADMIN_CONFIG_FILE ?? './data/admin-config.json'
let storedConfig = await loadStoredConfig()
let modelProviderApiKeys: Record<string, string> = {
  blector: process.env.AI_API_KEY ?? '',
  ...(storedConfig.modelProviderApiKeys ?? {}),
}
let modelProviders: ModelProviderConfig[] = buildModelProviders(storedConfig)
let modelProvider: ModelProviderConfig = activeModelProvider()
let imageSkillApiKey = storedConfig.imageSkillApiKey ?? process.env.IMAGE_API_KEY ?? ''
let imageSkill: ImageSkillConfig = buildImageSkillConfig(storedConfig.imageSkill)
let videoSkillApiKey = storedConfig.videoSkillApiKey ?? process.env.VOLCENGINE_ARK_API_KEY ?? ''
let videoSkill: VideoSkillConfig = buildVideoSkillConfig(storedConfig.videoSkill)
let plugins: PluginDefinition[] = normalizePlugins(storedConfig.plugins)
let mailAuthCode = storedConfig.mailAuthCode ?? process.env.QQ_MAIL_AUTH_CODE ?? ''
let mailSettings: MailServiceConfig = buildMailSettings(storedConfig.mailSettings)
let paymentGatewayKey = storedConfig.paymentGatewayKey ?? process.env.ZPAYZ_KEY ?? ''
let paymentGateway: PaymentGatewayConfig = buildPaymentGateway(storedConfig.paymentGateway)
let tokenPlans: TokenPlan[] = normalizeTokenPlans(storedConfig.tokenPlans)
let rechargeOrders: RechargeOrder[] = storedConfig.rechargeOrders ?? []
let users: AccountUser[] = storedConfig.users ?? []
let sessions = storedConfig.sessions ?? []
let videoTaskCharges: VideoTaskCharge[] = storedConfig.videoTaskCharges ?? []
let generatedAssets: GeneratedAssetRecord[] = storedConfig.generatedAssets ?? []
let clientLogs: ClientLogRecord[] = storedConfig.clientLogs ?? []
let usageReportIds = new Set(storedConfig.usageReportIds ?? [])
let adminAuth: AdminAuthConfig | undefined = storedConfig.adminAuth ?? buildAdminAuthFromEnv()
let adminSessions: AdminSession[] = storedConfig.adminSessions ?? []
const verificationCodes = new Map<string, { code: string; expiresAt: number; createdAt: number }>()
const imageGenerationJobs = new Map<string, ImageGenerationJob>()
const maxImageGenerationJobs = 200
const maxStoredClientLogs = 2000
let persistStoredConfigInFlight: Promise<void> | null = null
let persistStoredConfigDirty = false
let scheduledPersistStoredConfig: NodeJS.Timeout | undefined

if (needsStoredConfigMigration(storedConfig)) {
  await persistStoredConfig()
}

const policy: EnterprisePolicy = {
  dataBoundary: 'local',
  auditEnabled: true,
  externalSharing: 'allowed',
  highRiskToolMode: 'auto',
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

async function writeStoredConfig() {
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(
    configFile,
    JSON.stringify(
      {
        imageSkill: toStoredImageSkillConfig(imageSkill),
        imageSkillApiKey,
        modelProviderApiKeys,
        modelProviders: modelProviders.map(toStoredModelProviderConfig),
        videoSkill: toStoredVideoSkillConfig(videoSkill),
        videoSkillApiKey,
        plugins,
        adminAuth,
        adminSessions,
        mailSettings,
        mailAuthCode,
        paymentGateway: toStoredPaymentGateway(paymentGateway),
        paymentGatewayKey,
        tokenPlans,
        rechargeOrders,
        users,
        sessions,
        videoTaskCharges,
        generatedAssets,
        clientLogs: clientLogs.slice(0, maxStoredClientLogs),
        usageReportIds: Array.from(usageReportIds).slice(-5000),
      },
      null,
      2,
    ),
  )
}

async function persistStoredConfig() {
  if (persistStoredConfigInFlight) {
    persistStoredConfigDirty = true
    return persistStoredConfigInFlight
  }

  persistStoredConfigInFlight = (async () => {
    do {
      persistStoredConfigDirty = false
      await writeStoredConfig()
    } while (persistStoredConfigDirty)
  })().finally(() => {
    persistStoredConfigInFlight = null
  })

  return persistStoredConfigInFlight
}

function schedulePersistStoredConfig(delayMs = 1000) {
  if (scheduledPersistStoredConfig) return
  scheduledPersistStoredConfig = setTimeout(() => {
    scheduledPersistStoredConfig = undefined
    void persistStoredConfig()
  }, delayMs)
}

function needsStoredConfigMigration(config: StoredAdminConfig) {
  return (
    !config.modelProviders ||
    !config.imageSkill ||
    !config.videoSkill ||
    !config.plugins ||
    'maskedApiKey' in config.imageSkill ||
    'apiKeyConfigured' in config.imageSkill ||
    'maskedApiKey' in config.videoSkill ||
    'apiKeyConfigured' in config.videoSkill
  )
}

function toStoredModelProviderConfig(provider: ModelProviderConfig): Omit<ModelProviderConfig, 'maskedApiKey'> {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
    monthlyLimit: provider.monthlyLimit,
  }
}

function defaultModelProviders(): ModelProviderConfig[] {
  return [
    {
      id: 'blector',
      name: 'Blector 中转',
      baseUrl: process.env.AI_BASE_URL ?? 'https://ai.blector.com/v1',
      maskedApiKey: maskKey(modelProviderApiKeys.blector),
      defaultModel: process.env.AI_MODEL ?? 'gpt-5.5',
      enabled: true,
      monthlyLimit: 5000000,
    },
    {
      id: 'local',
      name: '本地私有模型',
      baseUrl: 'http://model-gateway:8000/v1',
      maskedApiKey: maskKey(modelProviderApiKeys.local),
      defaultModel: 'qwen3-coder',
      enabled: false,
      monthlyLimit: 5000000,
    },
  ]
}

function normalizeModelProviders(providers: ModelProviderConfig[]) {
  const seen = new Set<string>()
  const unique = providers.filter((provider) => {
    if (seen.has(provider.id)) return false
    seen.add(provider.id)
    return true
  })
  const enabledIndex = unique.findIndex((provider) => provider.enabled)
  return unique.map((provider, index) => ({
    ...provider,
    maskedApiKey: maskKey(modelProviderApiKeys[provider.id]),
    enabled: enabledIndex < 0 ? index === 0 : index === enabledIndex,
    monthlyLimit: provider.monthlyLimit ?? 5000000,
  }))
}

function buildModelProviders(config: StoredAdminConfig): ModelProviderConfig[] {
  const stored = config.modelProviders ?? (config.modelProvider ? [config.modelProvider] : undefined)
  if (!stored?.length) return normalizeModelProviders(defaultModelProviders())

  return normalizeModelProviders(
    stored.map((provider) => ({
      ...provider,
      maskedApiKey: maskKey(modelProviderApiKeys[provider.id]),
      monthlyLimit: provider.monthlyLimit ?? 5000000,
    })),
  )
}

function activeModelProvider() {
  return modelProviders.find((provider) => provider.enabled) ?? modelProviders[0]
}

function refreshActiveModelProvider() {
  modelProviders = normalizeModelProviders(modelProviders)
  modelProvider = activeModelProvider()
}

function createModelProviderId(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = slug || 'provider'
  if (!modelProviders.some((provider) => provider.id === base)) return base
  return `${base}-${randomUUID().slice(0, 8)}`
}

function toStoredImageSkillConfig(skill: ImageSkillConfig): Omit<ImageSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'> {
  return {
    id: skill.id,
    name: skill.name,
    provider: skill.provider,
    baseUrl: skill.baseUrl,
    defaultModel: skill.defaultModel,
    enabled: skill.enabled,
    defaultSize: skill.defaultSize,
    monthlyLimit: skill.monthlyLimit,
  }
}

function toStoredVideoSkillConfig(skill: VideoSkillConfig): Omit<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'> {
  return {
    id: skill.id,
    name: skill.name,
    provider: skill.provider,
    baseUrl: skill.baseUrl,
    defaultModel: skill.defaultModel,
    enabled: skill.enabled,
    allowImageInput: skill.allowImageInput,
    defaultDuration: skill.defaultDuration,
    defaultRatio: skill.defaultRatio,
    defaultResolution: skill.defaultResolution,
    monthlyLimit: skill.monthlyLimit,
  }
}

function toStoredPaymentGateway(gateway: PaymentGatewayConfig): Omit<PaymentGatewayConfig, 'maskedKey' | 'keyConfigured'> {
  return {
    id: gateway.id,
    name: gateway.name,
    provider: gateway.provider,
    gatewayUrl: gateway.gatewayUrl,
    pid: gateway.pid,
    enabled: gateway.enabled,
    supportedMethods: gateway.supportedMethods,
  }
}

function normalizeVideoRatio(value: unknown, model?: string): VideoRatio {
  if (typeof value === 'string' && videoRatioOptions.includes(value as VideoRatio)) return value as VideoRatio
  return defaultVideoRatioForModel(model)
}

function normalizeVideoResolution(value: unknown): VideoResolution {
  if (typeof value === 'string' && videoResolutionOptions.includes(value as VideoResolution)) return value as VideoResolution
  return '720p'
}

function buildImageSkillConfig(stored?: StoredAdminConfig['imageSkill']): ImageSkillConfig {
  const apiKeyConfigured = Boolean(imageSkillApiKey)
  return {
    id: stored?.id ?? 'gpt-image-2',
    name: stored?.name ?? 'gpt-image-2 图片生成',
    provider: 'openai-compatible-image',
    baseUrl: stored?.baseUrl ?? process.env.IMAGE_BASE_URL ?? 'https://codex-manager.tminos.com/v1',
    maskedApiKey: maskKey(imageSkillApiKey),
    apiKeyConfigured,
    defaultModel: stored?.defaultModel ?? process.env.IMAGE_MODEL ?? 'gpt-image-2',
    enabled: stored?.enabled ?? apiKeyConfigured,
    defaultSize: stored?.defaultSize ?? '1024x1024',
    monthlyLimit: stored?.monthlyLimit ?? 1000,
  }
}

function buildVideoSkillConfig(stored?: StoredAdminConfig['videoSkill']): VideoSkillConfig {
  const apiKeyConfigured = Boolean(videoSkillApiKey)
  const defaultModel = stored?.defaultModel ?? process.env.VOLCENGINE_VIDEO_MODEL ?? 'doubao-seedance-2-0-260128'
  return {
    id: stored?.id ?? 'volcengine-seedance',
    name: stored?.name ?? '火山方舟 Seedance 视频生成',
    provider: 'volcengine-ark',
    baseUrl: stored?.baseUrl ?? process.env.VOLCENGINE_ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    maskedApiKey: maskKey(videoSkillApiKey),
    apiKeyConfigured,
    defaultModel,
    enabled: stored?.enabled ?? apiKeyConfigured,
    allowImageInput: stored?.allowImageInput ?? true,
    defaultDuration: stored?.defaultDuration ?? 5,
    defaultRatio: normalizeVideoRatio(stored?.defaultRatio, defaultModel),
    defaultResolution: normalizeVideoResolution(stored?.defaultResolution),
    monthlyLimit: stored?.monthlyLimit ?? 100,
  }
}

function createSlug(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || randomUUID().slice(0, 8)
}

function normalizePlugin(plugin: Partial<PluginDefinition> & Pick<PluginDefinition, 'name'>): PluginDefinition {
  const enabled = Boolean(plugin.enabled)
  const ready = plugin.ready ?? true
  return {
    id: plugin.id ?? createSlug(plugin.name),
    name: plugin.name,
    description: plugin.description ?? '',
    category: plugin.category ?? 'custom',
    handler: plugin.handler ?? 'runtime',
    interactionMode: plugin.interactionMode ?? 'requires_user_input',
    targetTools: plugin.targetTools ?? [],
    triggerPolicy: plugin.triggerPolicy ?? (plugin.targetTools?.length ? 'before_tool' : 'manual'),
    enabled,
    ready,
    status: !ready ? 'needs_config' : enabled ? 'ready' : 'disabled',
    triggerHints: plugin.triggerHints ?? [],
    inputFields: plugin.inputFields ?? [],
    permissions: plugin.permissions ?? [],
    quotaType: plugin.quotaType ?? 'task',
    updatedAt: plugin.updatedAt ?? new Date().toISOString(),
  }
}

function defaultPlugins(): PluginDefinition[] {
  return [
    normalizePlugin({
      id: 'interactive-video-request',
      name: '视频生成表单',
      description: 'Codex 需要用户补充文本、首尾帧、参考图/视频/音频和生成参数时，弹出多模态视频表单。',
      category: 'media',
      handler: 'runtime',
      interactionMode: 'requires_user_input',
      targetTools: ['video_generation'],
      triggerPolicy: 'before_tool',
      enabled: true,
      triggerHints: ['生成视频', '图生视频', '文生视频', '做短片'],
      inputFields: interactiveVideoPluginInputFields,
      permissions: ['请求用户补充参数', '读取用户上传素材', '把表单结果交回 Codex'],
      quotaType: 'task',
    }),
  ]
}

function normalizePlugins(stored?: PluginDefinition[]): PluginDefinition[] {
  const defaults = defaultPlugins()
  const source = stored?.length ? stored : defaults
  const normalized = source.map((plugin) => normalizePlugin(plugin))

  return defaults.map((defaultPlugin) => {
    const existing = normalized.find((plugin) => plugin.id === defaultPlugin.id)
    if (!existing) return defaultPlugin
    if (defaultPlugin.id === 'interactive-video-request') {
      const rawExisting = source.find((plugin) => plugin.id === defaultPlugin.id)
      const migratedTriggerPolicy = rawExisting?.triggerPolicy
        ?? (rawExisting?.targetTools?.length ? 'before_tool' : defaultPlugin.triggerPolicy)
      const hasSeedanceFields = hasSeedanceInteractiveVideoPluginFields(existing.inputFields)
      const hasLegacyVideoFields = hasLegacyInteractiveVideoPluginFields(existing.inputFields)
      return normalizePlugin({
        ...defaultPlugin,
        ...existing,
        inputFields: hasSeedanceFields && !hasLegacyVideoFields ? mergePluginFields(defaultPlugin.inputFields, existing.inputFields) : defaultPlugin.inputFields,
        targetTools: existing.targetTools?.length ? existing.targetTools : defaultPlugin.targetTools,
        triggerPolicy: migratedTriggerPolicy,
        enabled: existing.enabled,
        ready: existing.ready,
        updatedAt: existing.updatedAt,
      })
    }
    return existing
  }).concat(normalized.filter((plugin) => !defaults.some((defaultPlugin) => defaultPlugin.id === plugin.id)))
}

function mergePluginFields(defaultFields: PluginDefinition['inputFields'], storedFields: PluginDefinition['inputFields'] = []) {
  const fields = [...storedFields]
  for (const field of defaultFields) {
    if (!fields.some((item) => item.id === field.id)) fields.push(field)
  }
  return fields
}

function buildMailSettings(stored?: Omit<MailServiceConfig, 'maskedAuthCode' | 'authCodeConfigured'>): MailServiceConfig {
  const authCodeConfigured = Boolean(mailAuthCode)
  return {
    smtpHost: stored?.smtpHost ?? process.env.MAIL_SMTP_HOST ?? 'smtp.qq.com',
    smtpPort: stored?.smtpPort ?? Number(process.env.MAIL_SMTP_PORT ?? 465),
    secure: stored?.secure ?? true,
    username: stored?.username ?? process.env.MAIL_USERNAME ?? '',
    fromName: stored?.fromName ?? process.env.MAIL_FROM_NAME ?? '墨渊',
    maskedAuthCode: maskKey(mailAuthCode),
    authCodeConfigured,
    enabled: stored?.enabled ?? Boolean(authCodeConfigured && (stored?.username ?? process.env.MAIL_USERNAME)),
  }
}

function buildPaymentGateway(stored?: StoredAdminConfig['paymentGateway']): PaymentGatewayConfig {
  const keyConfigured = Boolean(paymentGatewayKey)
  return {
    id: stored?.id ?? 'zpayz',
    name: stored?.name ?? 'ZPAYZ 支付网关',
    provider: 'zpayz',
    gatewayUrl: stored?.gatewayUrl ?? process.env.ZPAYZ_GATEWAY_URL ?? 'https://zpayz.cn',
    pid: stored?.pid ?? process.env.ZPAYZ_PID ?? '',
    maskedKey: maskKey(paymentGatewayKey),
    keyConfigured,
    enabled: stored?.enabled ?? Boolean(keyConfigured && (stored?.pid ?? process.env.ZPAYZ_PID)),
    supportedMethods: stored?.supportedMethods?.length ? stored.supportedMethods : ['alipay', 'wxpay'],
  }
}

function defaultTokenPlans(): TokenPlan[] {
  const now = new Date().toISOString()
  return [
    {
      id: 'starter',
      name: '入门包',
      description: '适合轻量对话和少量图片生成',
      price: 9.9,
      tokens: 100000,
      enabled: true,
      sort: 10,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'standard',
      name: '标准包',
      description: '适合日常高频办公与技能调用',
      price: 39.9,
      tokens: 500000,
      enabled: true,
      sort: 20,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'pro',
      name: '专业包',
      description: '适合图片、视频等高消耗任务',
      price: 99,
      tokens: 1500000,
      enabled: true,
      sort: 30,
      createdAt: now,
      updatedAt: now,
    },
  ]
}

function normalizeTokenPlans(plans?: TokenPlan[]) {
  const source = plans?.length ? plans : defaultTokenPlans()
  return source
    .map((plan, index) => ({
      ...plan,
      description: plan.description ?? '',
      enabled: plan.enabled ?? true,
      sort: typeof plan.sort === 'number' ? plan.sort : (index + 1) * 10,
      updatedAt: plan.updatedAt ?? plan.createdAt ?? new Date().toISOString(),
    }))
    .sort((left, right) => left.sort - right.sort || left.price - right.price)
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function hashPassword(password: string, salt: string) {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex')
}

function buildAdminAuth(username: string, password: string): AdminAuthConfig {
  const passwordSalt = randomUUID()
  return {
    username: username.trim(),
    passwordSalt,
    passwordHash: hashPassword(password, passwordSalt),
    updatedAt: new Date().toISOString(),
  }
}

function buildAdminAuthFromEnv() {
  const username = process.env.ADMIN_USERNAME?.trim()
  const password = process.env.ADMIN_PASSWORD?.trim()
  if (!username || !password) return undefined
  return buildAdminAuth(username, password)
}

function verifyPassword(password: string, auth: AdminAuthConfig) {
  const expected = Buffer.from(auth.passwordHash)
  const actual = Buffer.from(hashPassword(password, auth.passwordSalt))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function normalizeUser(user: AccountUser): AccountUser {
  if (typeof user.skillTokens !== 'number') user.skillTokens = 0
  if (typeof user.promptTokens !== 'number') user.promptTokens = 0
  if (typeof user.completionTokens !== 'number') user.completionTokens = 0
  if (typeof user.tokenUsed !== 'number') user.tokenUsed = user.promptTokens + user.completionTokens + user.skillTokens
  return user
}

function sanitizeUser(user: AccountUser): AccountUser {
  return { ...normalizeUser(user) }
}

function createSession(userId: string) {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const now = new Date().toISOString()
  sessions = [{ tokenHash: tokenHash(token), userId, createdAt: now, lastSeenAt: now }, ...sessions].slice(0, 500)
  void persistStoredConfig()
  return token
}

function createAdminSession() {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const now = new Date().toISOString()
  adminSessions = [{ tokenHash: tokenHash(token), createdAt: now, lastSeenAt: now }, ...adminSessions].slice(0, 100)
  void persistStoredConfig()
  return token
}

function getAuthToken(request: { headers: Record<string, unknown> }) {
  const authHeader = String(request.headers.authorization ?? '')
  if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length)
  return String(request.headers['x-moyuan-auth-token'] ?? '')
}

function getRequestAdmin(request: { headers: Record<string, unknown> }) {
  if (!adminAuth) return undefined
  const token = getAuthToken(request)
  if (!token) return undefined
  const session = adminSessions.find((item) => item.tokenHash === tokenHash(token))
  if (!session) return undefined
  session.lastSeenAt = new Date().toISOString()
  return { username: adminAuth.username }
}

function getUserByToken(token: string) {
  if (!token) return undefined
  const hash = tokenHash(token)
  const session = sessions.find((item) => item.tokenHash === hash)
  if (!session) return undefined
  session.lastSeenAt = new Date().toISOString()
  return users.find((user) => user.id === session.userId && user.status === 'active')
}

function getRequestUser(request: { headers: Record<string, unknown> }) {
  return getUserByToken(getAuthToken(request))
}

function unauthorized(reply: { status: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  return reply.status(401).send({ error: '请先登录' })
}

async function requireUser(request: { headers: Record<string, unknown> }, reply: { status: (statusCode: number) => { send: (payload: unknown) => unknown } }) {
  const user = getUserByToken(getAuthToken(request))
  if (!user) {
    return reply.status(401).send({ error: '请先登录' })
  }
  return user
}

app.addHook('preHandler', async (request, reply) => {
  const pathname = request.url.split('?')[0]
  if (!pathname.startsWith('/api/admin/')) return
  if (pathname.startsWith('/api/admin/admin-auth/')) return
  if (pathname.startsWith('/api/admin/auth/')) return
  if (pathname.startsWith('/api/admin/payments/zpayz/notify')) return
  if (pathname.startsWith('/api/admin/me/recharge')) return
  if (pathname.startsWith('/api/admin/skills/')) return
  if (pathname === '/api/admin/desktop/bootstrap') return
  if (pathname.startsWith('/api/admin/model-proxy/')) return
  if (pathname === '/api/admin/client-logs' && request.method === 'POST') return
  if (pathname === '/api/admin/me' || pathname === '/api/admin/me/usage') return

  if (!adminAuth) return
  if (!getRequestAdmin(request)) {
    return reply.status(401).send({ error: adminAuth ? '请先登录管理员账号' : '请先初始化管理员账号' })
  }
})

function verifyCode(email: string, code: string) {
  const normalized = email.toLowerCase()
  const record = verificationCodes.get(normalized)
  if (!record || record.expiresAt < Date.now()) return false
  if (record.code !== code.trim()) return false
  verificationCodes.delete(normalized)
  return true
}

async function sendVerificationCode(email: string, code: string) {
  if (!mailSettings.enabled || !mailSettings.username || !mailAuthCode) {
    throw new Error('邮件服务未配置，请先在后台配置 SMTP 授权码')
  }

  const transporter = nodemailer.createTransport({
    host: mailSettings.smtpHost,
    port: mailSettings.smtpPort,
    secure: mailSettings.secure,
    auth: {
      user: mailSettings.username,
      pass: mailAuthCode,
    },
  })

  await transporter.sendMail({
    from: `"${mailSettings.fromName}" <${mailSettings.username}>`,
    to: email,
    subject: '墨渊登录验证码',
    text: `你的墨渊验证码是 ${code}，10 分钟内有效。`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#1f2328"><h2>墨渊登录验证码</h2><p>你的验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>10 分钟内有效。不是你本人操作可以忽略这封邮件。</p></div>`,
  })
}

async function sendTestMail() {
  if (!mailSettings.enabled || !mailSettings.username || !mailAuthCode) {
    throw new Error('邮件服务未配置，请先保存并启用 SMTP 授权码')
  }

  const transporter = nodemailer.createTransport({
    host: mailSettings.smtpHost,
    port: mailSettings.smtpPort,
    secure: mailSettings.secure,
    auth: {
      user: mailSettings.username,
      pass: mailAuthCode,
    },
  })

  await transporter.sendMail({
    from: `"${mailSettings.fromName}" <${mailSettings.username}>`,
    to: mailSettings.username,
    subject: '墨渊邮箱服务测试',
    text: '这是一封墨渊后台邮箱服务测试邮件，收到它说明 SMTP 授权码可以正常发送验证码。',
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#1f2328"><h2>墨渊邮箱服务测试</h2><p>收到这封邮件，说明 SMTP 授权码可以正常发送验证码。</p></div>`,
  })
}

function buildDesktopBootstrap() {
  return {
    employee: employees[0],
    policy,
    runtime: {
      codexRuntimeUrl: process.env.CODEX_RUNTIME_URL ?? 'http://localhost:4100',
      modelProvider: {
        id: modelProvider.id,
        name: modelProvider.name,
        baseUrl: modelProvider.baseUrl,
        defaultModel: modelProvider.defaultModel,
        enabled: modelProvider.enabled,
        apiKeyConfigured: Boolean(modelProviderApiKeys[modelProvider.id]),
        monthlyLimit: modelProvider.monthlyLimit,
      },
      skills: {
        imageGeneration: {
          apiKeyConfigured: imageSkill.apiKeyConfigured,
          baseUrl: imageSkill.baseUrl,
          defaultModel: imageSkill.defaultModel,
          defaultSize: imageSkill.defaultSize,
          enabled: imageSkill.enabled,
          name: imageSkill.name,
          provider: imageSkill.provider,
        },
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
      plugins: plugins.filter((plugin) => plugin.enabled && plugin.status === 'ready'),
    },
  }
}

function imageSkillGenerationUrl() {
  return `${imageSkill.baseUrl.replace(/\/$/, '')}/images/generations`
}

function videoSkillTaskUrl(taskId?: string) {
  const base = videoSkill.baseUrl.replace(/\/$/, '')
  const path = taskId ? `/contents/generations/tasks/${encodeURIComponent(taskId)}` : '/contents/generations/tasks'
  return `${base}${path}`
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

async function readUpstreamJson(response: Response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { message: text }
  }
}

function usageTotalTokens(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== 'object') return undefined
  const total = (usage as { total_tokens?: unknown; totalTokens?: unknown }).total_tokens ?? (usage as { total_tokens?: unknown; totalTokens?: unknown }).totalTokens
  return typeof total === 'number' && Number.isFinite(total) && total >= 0 ? Math.ceil(total) : undefined
}

function chargeSkillTokens(user: AccountUser, totalTokens: number) {
  normalizeUser(user)
  if (totalTokens <= 0) throw new Error('技能接口没有返回有效 usage.total_tokens，无法计费')
  const remainingTokens = user.tokenBudget - user.tokenUsed
  if (totalTokens > remainingTokens) {
    throw new Error('Token 额度不足，请联系管理员派发额度')
  }
  user.skillTokens += totalTokens
  user.tokenUsed += totalTokens
}

function normalizedVideoStatus(status?: string) {
  const value = (status ?? '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'done', 'finish', 'finished'].some((item) => value.includes(item))) return 'completed'
  if (['failed', 'error', 'canceled', 'cancelled', 'rejected'].some((item) => value.includes(item))) return 'failed'
  return 'running'
}

function findVideoCharge(taskId: string, userId: string) {
  return videoTaskCharges.find((item) => item.taskId === taskId && item.userId === userId)
}

function chargeVideoTask(user: AccountUser, taskId: string, usageTokens: number) {
  const existing = findVideoCharge(taskId, user.id)
  if (existing) return existing

  chargeSkillTokens(user, usageTokens)
  const now = new Date().toISOString()
  const charge: VideoTaskCharge = {
    taskId,
    userId: user.id,
    tokens: usageTokens,
    status: 'completed',
    createdAt: now,
    updatedAt: now,
  }
  videoTaskCharges = [charge, ...videoTaskCharges].slice(0, 1000)
  return charge
}

function firstImageFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const data = (payload as { data?: unknown }).data
  return Array.isArray(data) && data[0] && typeof data[0] === 'object' ? (data[0] as { b64_json?: unknown; url?: unknown }) : undefined
}

function promptFromVideoContent(content: unknown) {
  if (!Array.isArray(content)) return ''
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const text = (item as { text?: unknown }).text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return ''
}

function upsertGeneratedAsset(input: {
  id?: string
  metadata?: Record<string, unknown>
  model: string
  prompt: string
  provider: string
  status: GeneratedAssetRecord['status']
  storageUrl?: string
  taskId?: string
  tokenUsage?: number
  type: GeneratedAssetRecord['type']
  url?: string
  user: AccountUser
}) {
  const now = new Date().toISOString()
  const existingIndex = input.taskId ? generatedAssets.findIndex((asset) => asset.taskId === input.taskId && asset.userId === input.user.id) : -1
  const existing = existingIndex >= 0 ? generatedAssets[existingIndex] : undefined
  const next: GeneratedAssetRecord = {
    id: existing?.id ?? input.id ?? randomUUID(),
    userEmail: input.user.email,
    userId: input.user.id,
    userName: input.user.name,
    type: input.type,
    prompt: input.prompt,
    model: input.model,
    url: input.url ?? existing?.url ?? '',
    storageUrl: input.storageUrl ?? existing?.storageUrl,
    taskId: input.taskId ?? existing?.taskId,
    status: input.status,
    tokenUsage: input.tokenUsage ?? existing?.tokenUsage ?? 0,
    provider: input.provider,
    metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  if (existingIndex >= 0) {
    generatedAssets[existingIndex] = next
  } else {
    generatedAssets = [next, ...generatedAssets].slice(0, 2000)
  }
  return next
}

function requestIp(request: { headers: Record<string, unknown>; ip?: string }) {
  const forwardedFor = String(request.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
  return forwardedFor || request.ip
}

function appendClientLog(user: AccountUser, payload: z.infer<typeof clientLogSchema>, request: { headers: Record<string, unknown>; ip?: string }) {
  const now = new Date().toISOString()
  const log: ClientLogRecord = {
    id: randomUUID(),
    userId: user.id,
    userEmail: user.email,
    userName: user.name,
    deviceId: payload.deviceId,
    deviceName: payload.deviceName,
    platform: payload.platform,
    osVersion: payload.osVersion,
    appVersion: payload.appVersion,
    source: payload.source,
    level: payload.level,
    event: payload.event,
    details: payload.details,
    taskId: payload.taskId,
    sessionId: payload.sessionId,
    workspace: payload.workspace,
    ip: requestIp(request),
    userAgent: payload.userAgent,
    createdAt: payload.timestamp ?? now,
    receivedAt: now,
  }
  clientLogs = [log, ...clientLogs].slice(0, maxStoredClientLogs)
  return log
}

function md5Hex(data: string) {
  return createHash('md5').update(data).digest('hex')
}

function paymentPublicBaseUrl(request?: { headers: Record<string, unknown> }) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_BASE_URL
  if (configured) return configured.replace(/\/$/, '')
  const host = request?.headers.host ? String(request.headers.host) : 'codex.tminos.com:18080'
  const protocol = String(request?.headers['x-forwarded-proto'] ?? 'http')
  return `${protocol}://${host}`.replace(/\/$/, '')
}

function zpayzSign(params: Record<string, unknown>, key: string) {
  const query = Object.entries(params)
    .filter(([name, value]) => name !== 'sign' && name !== 'sign_type' && value !== undefined && value !== null && String(value) !== '')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join('&')
  return md5Hex(`${query}${key}`)
}

function verifyZpayzPayload(payload: Record<string, unknown>) {
  const sign = typeof payload.sign === 'string' ? payload.sign.toLowerCase() : ''
  if (!paymentGatewayKey || !sign) return false
  return zpayzSign(payload, paymentGatewayKey).toLowerCase() === sign
}

function zpayzPaymentUrl(params: Record<string, string>) {
  const gateway = paymentGateway.gatewayUrl.replace(/\/$/, '')
  return `${gateway}/submit.php?${new URLSearchParams(params).toString()}`
}

function zpayzNotifySucceeded(payload: Record<string, unknown>) {
  const tradeStatus = String(payload.trade_status ?? payload.status ?? '').toLowerCase()
  return tradeStatus === 'trade_success' || tradeStatus === 'success' || tradeStatus === '1'
}

function createOutTradeNo() {
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  return `MY${timestamp}${randomInt(100000, 999999)}`
}

function createRechargeOrder(user: AccountUser, plan: TokenPlan, method: RechargeOrder['method'], request: { headers: Record<string, unknown> }) {
  if (!paymentGateway.enabled || !paymentGateway.keyConfigured || !paymentGateway.pid || !paymentGatewayKey) {
    throw new Error('支付网关未启用或未配置商户密钥')
  }
  if (!paymentGateway.supportedMethods.includes(method)) throw new Error('当前支付方式未启用')

  const now = new Date().toISOString()
  const outTradeNo = createOutTradeNo()
  const publicBase = paymentPublicBaseUrl(request)
  const params = {
    money: plan.price.toFixed(2),
    name: plan.name,
    notify_url: `${publicBase}/admin-api/payments/zpayz/notify`,
    out_trade_no: outTradeNo,
    pid: paymentGateway.pid,
    return_url: `${publicBase}/admin/`,
    sign_type: 'MD5',
    type: method,
  }
  const sign = zpayzSign(params, paymentGatewayKey)
  const payUrl = zpayzPaymentUrl({ ...params, sign })
  const order: RechargeOrder = {
    id: randomUUID(),
    userEmail: user.email,
    userId: user.id,
    userName: user.name,
    planId: plan.id,
    planName: plan.name,
    tokens: plan.tokens,
    amount: plan.price,
    provider: paymentGateway.provider,
    method,
    status: 'pending',
    outTradeNo,
    payUrl,
    createdAt: now,
    updatedAt: now,
  }
  rechargeOrders = [order, ...rechargeOrders].slice(0, 5000)
  return order
}

function completeRechargeOrder(order: RechargeOrder, tradeNo?: string) {
  const user = users.find((item) => item.id === order.userId)
  if (!user) throw new Error('订单用户不存在')
  if (order.status === 'paid') return order

  const now = new Date().toISOString()
  normalizeUser(user)
  user.tokenBudget += order.tokens
  user.quotaUpdatedAt = now
  order.status = 'paid'
  order.tradeNo = tradeNo || order.tradeNo
  order.paidAt = now
  order.updatedAt = now
  return order
}

function hmac(key: Buffer | string, data: string) {
  return createHmac('sha256', key).update(data).digest()
}

function sha256Hex(data: Buffer | string) {
  return createHash('sha256').update(data).digest('hex')
}

function minioConfig() {
  const endpoint = process.env.MINIO_ENDPOINT?.replace(/\/$/, '')
  const accessKey = process.env.MINIO_ACCESS_KEY ?? process.env.MINIO_ROOT_USER
  const secretKey = process.env.MINIO_SECRET_KEY ?? process.env.MINIO_ROOT_PASSWORD
  const bucket = process.env.MINIO_BUCKET ?? 'worldcup-materials'
  if (!endpoint || !accessKey || !secretKey || !bucket) return undefined
  return {
    accessKey,
    bucket,
    endpoint,
    publicBaseUrl: (process.env.MINIO_PUBLIC_BASE_URL ?? `${endpoint}/${bucket}`).replace(/\/$/, ''),
    region: process.env.MINIO_REGION ?? 'us-east-1',
    secretKey,
  }
}

async function uploadToMinio(objectKey: string, bytes: Buffer, contentType: string) {
  const config = minioConfig()
  if (!config) return undefined

  const target = new URL(`${config.endpoint}/${config.bucket}/${objectKey}`)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256Hex(bytes)
  const headers = {
    'content-type': contentType,
    host: target.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key as keyof typeof headers]}\n`)
    .join('')
  const canonicalRequest = ['PUT', target.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretKey}`, dateStamp), config.region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const response = await fetch(target, {
    body: bytes as unknown as BodyInit,
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    method: 'PUT',
  })
  if (!response.ok) throw new Error(`MinIO 归档失败：${response.status}`)
  return `${config.publicBaseUrl}/${objectKey}`
}

function extensionForContentType(contentType: string, fileName?: string) {
  const existing = fileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1]
  if (existing) return existing.toLowerCase()
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
  if (contentType.includes('webp')) return 'webp'
  if (contentType.includes('mp4')) return 'mp4'
  if (contentType.includes('quicktime')) return 'mov'
  if (contentType.includes('mpeg')) return 'mp3'
  if (contentType.includes('wav')) return 'wav'
  return 'bin'
}

function parseDataUrl(dataUrl: string) {
  const matched = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s)
  if (!matched) throw new Error('素材不是有效的 data URL')
  const contentType = matched[1] || 'application/octet-stream'
  const isBase64 = Boolean(matched[2])
  const payload = matched[3] ?? ''
  const bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
  if (!bytes.length) throw new Error('素材内容为空')
  return { bytes, contentType }
}

async function callImageSkillApi(init: RequestInit) {
  if (!imageSkill.enabled || !imageSkillApiKey) {
    return { ok: false as const, status: 400, payload: { error: '图片生成技能未启用，请管理员在后台配置并启用 gpt-image-2 KEY' } }
  }

  const response = await fetch(imageSkillGenerationUrl(), {
    ...init,
    headers: {
      Authorization: `Bearer ${imageSkillApiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const payload = await readUpstreamJson(response)
  return { ok: response.ok, status: response.status, payload }
}

async function completeImageGeneration(user: AccountUser, body: ImageGenerationJob['body']) {
  const upstream = await callImageSkillApi({
    body: JSON.stringify(body),
    method: 'POST',
  })

  if (!upstream.ok) {
    const message = findFirstString(upstream.payload, ['message', 'error', 'msg']) ?? `图片生成接口返回 ${upstream.status}`
    throw new Error(message)
  }

  const usageTokens = usageTotalTokens(upstream.payload)
  if (!usageTokens) {
    throw new Error('图片生成接口没有返回 usage.total_tokens，无法计费')
  }

  chargeSkillTokens(user, usageTokens)

  const firstImage = firstImageFromPayload(upstream.payload)
  const upstreamUrl = typeof firstImage?.url === 'string' ? firstImage.url : undefined
  let storageUrl: string | undefined
  let storageError: string | undefined
  if (typeof firstImage?.b64_json === 'string' && firstImage.b64_json) {
    try {
      storageUrl = await uploadToMinio(`moyuan/images/${randomUUID()}.png`, Buffer.from(firstImage.b64_json, 'base64'), 'image/png')
    } catch (error) {
      storageError = error instanceof Error ? error.message : 'MinIO 归档失败'
    }
  }

  upsertGeneratedAsset({
    user,
    type: 'image',
    prompt: body.prompt,
    model: body.model,
    provider: imageSkill.provider,
    status: 'succeeded',
    tokenUsage: usageTokens,
    url: storageUrl ?? upstreamUrl ?? '',
    storageUrl,
    metadata: {
      size: body.size,
      storageError,
      upstreamId: findFirstString(upstream.payload, ['id']),
    },
  })

  await persistStoredConfig()
  return {
    raw: upstream.payload,
    storageUrl,
    usageTokens,
    user: sanitizeUser(user),
  }
}

function startImageGenerationJob(user: AccountUser, body: ImageGenerationJob['body']) {
  const now = new Date().toISOString()
  const job: ImageGenerationJob = {
    id: randomUUID(),
    userId: user.id,
    body,
    status: 'running',
    createdAt: now,
    updatedAt: now,
  }
  imageGenerationJobs.set(job.id, job)
  pruneImageGenerationJobs()

  void completeImageGeneration(user, body)
    .then((result) => {
      job.status = 'succeeded'
      job.result = result
      job.updatedAt = new Date().toISOString()
    })
    .catch(async (error) => {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : String(error)
      job.updatedAt = new Date().toISOString()
      upsertGeneratedAsset({
        user,
        type: 'image',
        prompt: body.prompt,
        model: body.model,
        provider: imageSkill.provider,
        status: 'failed',
        tokenUsage: 0,
        metadata: {
          error: job.error,
          size: body.size,
        },
      })
      await persistStoredConfig()
    })

  return job
}

function pruneImageGenerationJobs() {
  if (imageGenerationJobs.size <= maxImageGenerationJobs) return
  const jobs = Array.from(imageGenerationJobs.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  for (const job of jobs.slice(0, imageGenerationJobs.size - maxImageGenerationJobs)) {
    imageGenerationJobs.delete(job.id)
  }
}

function serializeImageGenerationJob(job: ImageGenerationJob) {
  if (job.status === 'succeeded' && job.result) {
    return {
      jobId: job.id,
      status: job.status,
      raw: job.result.raw,
      storageUrl: job.result.storageUrl,
      usageTokens: job.result.usageTokens,
      user: sanitizeUser(job.result.user),
    }
  }
  if (job.status === 'failed') {
    return {
      jobId: job.id,
      status: job.status,
      error: job.error ?? '图片生成失败',
    }
  }
  return {
    jobId: job.id,
    status: job.status,
  }
}

async function callVideoSkillApi(url: string, init: RequestInit) {
  if (!videoSkill.enabled || !videoSkillApiKey) {
    return { ok: false as const, status: 400, payload: { error: '视频生成技能未启用，请管理员在后台配置并启用火山方舟 KEY' } }
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${videoSkillApiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const payload = await readUpstreamJson(response)
  return { ok: response.ok, status: response.status, payload }
}

const hopByHopHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function modelProxyTarget(pathname: string, query = '') {
  const upstreamBase = modelProvider.baseUrl.replace(/\/$/, '')
  let upstreamPath = pathname.replace(/^\/api\/admin\/model-proxy/, '') || '/'
  if (upstreamBase.endsWith('/v1') && upstreamPath.startsWith('/v1/')) {
    upstreamPath = upstreamPath.slice('/v1'.length)
  }
  return `${upstreamBase}${upstreamPath}${query ? `?${query}` : ''}`
}

async function proxyModelProvider(request: { body?: unknown; headers: Record<string, unknown>; method: string; url: string }, reply: any) {
  const user = getUserByToken(getAuthToken(request))
  if (!user) return unauthorized(reply)
  if (user.status !== 'active') return reply.status(403).send({ error: '账号已停用，请联系管理员' })
  if (!modelProvider.enabled || !modelProviderApiKeys[modelProvider.id]) {
    return reply.status(400).send({ error: '模型通道未启用或未配置 KEY，请管理员在后台检查模型设置' })
  }

  const [pathname, query = ''] = request.url.split('?')
  const target = modelProxyTarget(pathname, query)
  const headers = new Headers()
  const contentType = request.headers['content-type']
  const accept = request.headers.accept
  if (typeof contentType === 'string') headers.set('Content-Type', contentType)
  if (typeof accept === 'string') headers.set('Accept', accept)
  headers.set('Authorization', `Bearer ${modelProviderApiKeys[modelProvider.id]}`)

  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : typeof request.body === 'string'
        ? request.body
        : request.body == null
          ? undefined
          : JSON.stringify(request.body)

  const response = await fetch(target, {
    body,
    headers,
    method: request.method,
  })

  reply.code(response.status)
  response.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) reply.header(key, value)
  })

  if (!response.body) return reply.send(null)
  return reply.send(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]))
}

app.get('/health', async () => ({
  ok: true,
  service: 'enterprise-api',
}))

app.get('/api/admin/admin-auth/state', async () => ({
  data: {
    configured: Boolean(adminAuth),
    username: adminAuth?.username ?? '',
  },
}))

app.post('/api/admin/admin-auth/setup', async (request, reply) => {
  if (adminAuth) return reply.status(409).send({ error: '管理员账号已初始化' })
  const parsed = adminAuthSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '管理员账号或密码不完整', detail: parsed.error.flatten() })

  adminAuth = buildAdminAuth(parsed.data.username, parsed.data.password)
  adminSessions = []
  const token = createAdminSession()
  await persistStoredConfig()
  return { data: { token, username: adminAuth.username } }
})

app.post('/api/admin/admin-auth/login', async (request, reply) => {
  if (!adminAuth) return reply.status(409).send({ error: '请先初始化管理员账号' })
  const parsed = adminAuthSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '管理员账号或密码不完整', detail: parsed.error.flatten() })
  if (parsed.data.username.trim() !== adminAuth.username || !verifyPassword(parsed.data.password, adminAuth)) {
    return reply.status(401).send({ error: '管理员账号或密码不正确' })
  }

  const token = createAdminSession()
  await persistStoredConfig()
  return { data: { token, username: adminAuth.username } }
})

app.get('/api/admin/admin-auth/me', async (request, reply) => {
  const admin = getRequestAdmin(request)
  if (!admin) return reply.status(401).send({ error: '请先登录管理员账号' })
  await persistStoredConfig()
  return { data: admin }
})

app.get('/api/admin/model-provider', async () => ({ data: modelProvider }))

app.get('/api/admin/model-providers', async () => ({ data: modelProviders }))

app.all('/api/admin/model-proxy/*', proxyModelProvider)

app.get('/api/admin/image-skill', async () => ({ data: imageSkill }))

app.get('/api/admin/video-skill', async () => ({ data: videoSkill }))

app.get('/api/admin/plugins', async () => ({ data: plugins }))

app.put('/api/admin/plugins/:id', async (request, reply) => {
  const params = pluginIdParamSchema.safeParse(request.params)
  const parsed = pluginDefinitionSchema.safeParse(request.body)
  if (!params.success || !parsed.success) {
    return reply.status(400).send({ error: '插件参数不完整' })
  }

  const existing = plugins.find((item) => item.id === params.data.id)
  if (!existing) return reply.status(404).send({ error: '插件不存在' })
  const updated = normalizePlugin({ ...existing, ...parsed.data, id: existing.id, updatedAt: new Date().toISOString() })
  plugins = plugins.map((item) => (item.id === updated.id ? updated : item))
  await persistStoredConfig()
  return { data: updated }
})

app.post('/api/admin/plugins', async (request, reply) => {
  const parsed = pluginDefinitionSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '插件参数不完整' })
  const plugin = normalizePlugin({ ...parsed.data, id: createSlug(parsed.data.name), updatedAt: new Date().toISOString() })
  if (plugins.some((item) => item.id === plugin.id)) {
    plugin.id = `${plugin.id}-${randomUUID().slice(0, 8)}`
  }
  plugins = [plugin, ...plugins]
  await persistStoredConfig()
  return { data: plugin }
})

app.delete('/api/admin/plugins/:id', async (request, reply) => {
  const params = pluginIdParamSchema.safeParse(request.params)
  if (!params.success) return reply.status(400).send({ error: '插件参数不完整' })
  const nextPlugins = plugins.filter((item) => item.id !== params.data.id)
  if (nextPlugins.length === plugins.length) return reply.status(404).send({ error: '插件不存在' })
  plugins = nextPlugins
  await persistStoredConfig()
  return { data: plugins }
})

app.get('/api/admin/mail-settings', async () => ({ data: mailSettings }))

app.get('/api/admin/payment-gateway', async () => ({ data: paymentGateway }))

app.get('/api/admin/token-plans', async () => ({ data: tokenPlans }))

app.get('/api/admin/recharge-orders', async () => ({ data: rechargeOrders }))

app.get('/api/admin/desktop/bootstrap', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  return { data: buildDesktopBootstrap() }
})

app.put('/api/admin/mail-settings', async (request, reply) => {
  const parsed = mailConfigSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '邮箱服务配置不完整', detail: parsed.error.flatten() })
  }

  if (parsed.data.authCode?.trim()) {
    mailAuthCode = parsed.data.authCode.trim()
  }

  if (parsed.data.enabled && !mailAuthCode) {
    return reply.status(400).send({ error: '启用邮箱服务前，请先配置授权码' })
  }

  mailSettings = {
    smtpHost: parsed.data.smtpHost,
    smtpPort: parsed.data.smtpPort,
    secure: parsed.data.secure,
    username: parsed.data.username,
    fromName: parsed.data.fromName,
    maskedAuthCode: maskKey(mailAuthCode),
    authCodeConfigured: Boolean(mailAuthCode),
    enabled: parsed.data.enabled,
  }

  await persistStoredConfig()
  return { data: mailSettings }
})

app.post('/api/admin/mail-settings/test', async (_request, reply) => {
  try {
    await sendTestMail()
    return { data: { sent: true } }
  } catch (error) {
    return reply.status(500).send({ error: error instanceof Error ? error.message : '测试邮件发送失败' })
  }
})

app.put('/api/admin/payment-gateway', async (request, reply) => {
  const parsed = paymentGatewayConfigSchema.safeParse(request.body)
  if (!parsed.success) {
    return reply.status(400).send({ error: '支付网关配置不完整', detail: parsed.error.flatten() })
  }

  if (parsed.data.key?.trim()) {
    paymentGatewayKey = parsed.data.key.trim()
  }

  if (parsed.data.enabled && !paymentGatewayKey) {
    return reply.status(400).send({ error: '启用支付网关前，请先配置商户密钥' })
  }

  paymentGateway = {
    id: 'zpayz',
    name: 'ZPAYZ 支付网关',
    provider: 'zpayz',
    gatewayUrl: parsed.data.gatewayUrl,
    pid: parsed.data.pid,
    maskedKey: maskKey(paymentGatewayKey),
    keyConfigured: Boolean(paymentGatewayKey),
    enabled: parsed.data.enabled,
    supportedMethods: parsed.data.supportedMethods,
  }

  await persistStoredConfig()
  return { data: paymentGateway }
})

app.post('/api/admin/token-plans', async (request, reply) => {
  const parsed = tokenPlanSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '套餐参数不完整', detail: parsed.error.flatten() })

  const now = new Date().toISOString()
  const plan: TokenPlan = {
    id: randomUUID(),
    name: parsed.data.name,
    description: parsed.data.description,
    price: parsed.data.price,
    tokens: parsed.data.tokens,
    enabled: parsed.data.enabled,
    sort: parsed.data.sort,
    createdAt: now,
    updatedAt: now,
  }
  tokenPlans = normalizeTokenPlans([plan, ...tokenPlans])
  await persistStoredConfig()
  return { data: plan }
})

app.put('/api/admin/token-plans/:id', async (request, reply) => {
  const params = z.object({ id: z.string().min(1) }).safeParse(request.params)
  if (!params.success) return reply.status(400).send({ error: '套餐参数不正确' })

  const parsed = tokenPlanSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '套餐参数不完整', detail: parsed.error.flatten() })

  const index = tokenPlans.findIndex((plan) => plan.id === params.data.id)
  if (index < 0) return reply.status(404).send({ error: '套餐不存在' })
  const nextPlan = {
    ...tokenPlans[index],
    name: parsed.data.name,
    description: parsed.data.description,
    price: parsed.data.price,
    tokens: parsed.data.tokens,
    enabled: parsed.data.enabled,
    sort: parsed.data.sort,
    updatedAt: new Date().toISOString(),
  }
  tokenPlans[index] = nextPlan
  tokenPlans = normalizeTokenPlans(tokenPlans)
  await persistStoredConfig()
  return { data: nextPlan }
})

app.delete('/api/admin/token-plans/:id', async (request, reply) => {
  const params = z.object({ id: z.string().min(1) }).safeParse(request.params)
  if (!params.success) return reply.status(400).send({ error: '套餐参数不正确' })
  tokenPlans = tokenPlans.filter((plan) => plan.id !== params.data.id)
  await persistStoredConfig()
  return { data: tokenPlans }
})

app.get('/api/admin/me/recharge-plans', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  return { data: tokenPlans.filter((plan) => plan.enabled) }
})

app.get('/api/admin/me/recharge-orders', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  return { data: rechargeOrders.filter((order) => order.userId === user.id).slice(0, 100) }
})

app.post('/api/admin/me/recharge-orders', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  const parsed = rechargeOrderSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '充值参数不完整', detail: parsed.error.flatten() })

  const plan = tokenPlans.find((item) => item.id === parsed.data.planId && item.enabled)
  if (!plan) return reply.status(404).send({ error: '套餐不存在或已下架' })

  try {
    const order = createRechargeOrder(user, plan, parsed.data.method, request)
    await persistStoredConfig()
    return { data: order }
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : '创建支付订单失败' })
  }
})

app.all('/api/admin/payments/zpayz/notify', async (request, reply) => {
  const payload = {
    ...((request.query ?? {}) as Record<string, unknown>),
    ...((request.body ?? {}) as Record<string, unknown>),
  }
  if (!verifyZpayzPayload(payload)) return reply.status(400).send('fail')
  if (!zpayzNotifySucceeded(payload)) return reply.send('success')

  const outTradeNo = String(payload.out_trade_no ?? '')
  const order = rechargeOrders.find((item) => item.outTradeNo === outTradeNo)
  if (!order) return reply.status(404).send('fail')

  const money = Number(payload.money)
  if (Number.isFinite(money) && Math.abs(money - order.amount) >= 0.01) {
    order.status = 'failed'
    order.updatedAt = new Date().toISOString()
    await persistStoredConfig()
    return reply.status(400).send('fail')
  }

  completeRechargeOrder(order, typeof payload.trade_no === 'string' ? payload.trade_no : undefined)
  await persistStoredConfig()
  return reply.send('success')
})

app.get('/api/admin/users', async () => ({ data: users.map(sanitizeUser) }))

app.get('/api/admin/generated-assets', async () => ({
  data: generatedAssets,
}))

app.post('/api/admin/plugin-assets', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)

  const parsed = pluginAssetUploadSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '插件素材参数不完整', detail: parsed.error.flatten() })

  try {
    const { bytes, contentType } = parseDataUrl(parsed.data.dataUrl)
    const ext = extensionForContentType(parsed.data.type ?? contentType, parsed.data.name)
    const url = await uploadToMinio(`moyuan/plugin-assets/${user.id}/${randomUUID()}.${ext}`, bytes, parsed.data.type ?? contentType)
    if (!url) return reply.status(503).send({ error: '素材归档服务未配置，请管理员配置 MinIO' })
    return {
      data: {
        name: parsed.data.name,
        size: bytes.byteLength,
        type: parsed.data.type ?? contentType,
        url,
      },
    }
  } catch (error) {
    return reply.status(400).send({ error: error instanceof Error ? error.message : '插件素材上传失败' })
  }
})

app.get('/api/admin/client-logs', async (request) => {
  const query = z
    .object({
      deviceId: z.string().optional(),
      event: z.string().optional(),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      limit: z.coerce.number().int().positive().max(1000).default(300),
      userId: z.string().optional(),
    })
    .parse(request.query ?? {})
  const filtered = clientLogs.filter((log) => {
    if (query.level && log.level !== query.level) return false
    if (query.userId && log.userId !== query.userId) return false
    if (query.deviceId && log.deviceId !== query.deviceId) return false
    if (query.event && !log.event.toLowerCase().includes(query.event.toLowerCase())) return false
    return true
  })
  return { data: filtered.slice(0, query.limit) }
})

app.post('/api/admin/client-logs', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  normalizeUser(user)

  const parsed = clientLogSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '客户端日志参数不完整', detail: parsed.error.flatten() })

  const log = appendClientLog(user, parsed.data, request)
  schedulePersistStoredConfig()
  return { data: { id: log.id } }
})

app.put('/api/admin/users/:id/quota', async (request, reply) => {
  const params = userIdParamSchema.safeParse(request.params)
  if (!params.success) return reply.status(400).send({ error: '用户参数不正确' })

  const parsed = quotaSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '额度参数不正确', detail: parsed.error.flatten() })

  const user = users.find((item) => item.id === params.data.id)
  if (!user) return reply.status(404).send({ error: '用户不存在' })

  const amount = parsed.data.amount
  if (parsed.data.mode === 'grant' && amount < 1) {
    return reply.status(400).send({ error: '派发额度必须大于 0' })
  }

  if (parsed.data.mode === 'set' && amount < user.tokenUsed) {
    return reply.status(400).send({ error: '总额度不能低于该用户已使用 Token' })
  }

  user.tokenBudget = parsed.data.mode === 'grant' ? user.tokenBudget + amount : amount
  user.quotaUpdatedAt = new Date().toISOString()

  await persistStoredConfig()
  return { data: sanitizeUser(user) }
})

app.post('/api/admin/auth/send-code', async (request, reply) => {
  const parsed = sendCodeSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '邮箱地址不正确' })

  const email = parsed.data.email.toLowerCase()
  const code = String(randomInt(100000, 999999))
  verificationCodes.set(email, { code, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000 })

  try {
    await sendVerificationCode(email, code)
    return { data: { sent: true, expiresIn: 600 } }
  } catch (error) {
    verificationCodes.delete(email)
    return reply.status(500).send({ error: error instanceof Error ? error.message : '验证码发送失败' })
  }
})

app.post('/api/admin/auth/register', async (request, reply) => {
  const parsed = authSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '注册信息不完整' })
  const email = parsed.data.email.toLowerCase()
  if (!verifyCode(email, parsed.data.code)) return reply.status(400).send({ error: '验证码不正确或已过期' })

  let user = users.find((item) => item.email === email)
  const now = new Date().toISOString()
  if (!user) {
    user = {
      id: randomUUID(),
      email,
      name: parsed.data.name?.trim() || email.split('@')[0],
      status: 'active',
      tokenBudget: 0,
      tokenUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      skillTokens: 0,
      createdAt: now,
      lastLoginAt: now,
    }
    users = [user, ...users]
  } else {
    user.name = parsed.data.name?.trim() || user.name
    user.status = 'active'
    user.lastLoginAt = now
  }

  const token = createSession(user.id)
  await persistStoredConfig()
  return { data: { token, user: sanitizeUser(user) } }
})

app.post('/api/admin/auth/login', async (request, reply) => {
  const parsed = authSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '登录信息不完整' })
  const email = parsed.data.email.toLowerCase()
  if (!verifyCode(email, parsed.data.code)) return reply.status(400).send({ error: '验证码不正确或已过期' })

  const user = users.find((item) => item.email === email)
  if (!user || user.status !== 'active') return reply.status(404).send({ error: '账号不存在，请先注册' })

  user.lastLoginAt = new Date().toISOString()
  const token = createSession(user.id)
  await persistStoredConfig()
  return { data: { token, user: sanitizeUser(user) } }
})

app.get('/api/admin/me', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  return { data: { user: sanitizeUser(user) } }
})

app.post('/api/admin/me/usage', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  normalizeUser(user)
  const parsed = usageSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '用量数据不完整' })

  const reportId = parsed.data.reportId?.trim()
  if (reportId && usageReportIds.has(reportId)) {
    return { data: { user: sanitizeUser(user), duplicated: true } }
  }

  const promptTokens = parsed.data.promptTokens
  const completionTokens = parsed.data.completionTokens
  const skillTokens = parsed.data.skillTokens
  const totalTokens = parsed.data.totalTokens ?? promptTokens + completionTokens + skillTokens
  const remainingTokens = user.tokenBudget - user.tokenUsed
  if (totalTokens > remainingTokens) {
    return reply.status(402).send({ error: 'Token 额度不足，请联系管理员派发额度', data: { user: sanitizeUser(user) } })
  }
  user.promptTokens += promptTokens
  user.completionTokens += completionTokens
  user.skillTokens += skillTokens
  user.tokenUsed += totalTokens
  if (reportId) {
    usageReportIds.add(reportId)
    usageReportIds = new Set(Array.from(usageReportIds).slice(-5000))
  }
  await persistStoredConfig()
  return { data: { user: sanitizeUser(user) } }
})

app.post('/api/admin/skills/image/generations', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  normalizeUser(user)
  if (user.tokenBudget - user.tokenUsed <= 0) {
    return reply.status(402).send({ error: 'Token 额度不足，请联系管理员派发额度', data: { user: sanitizeUser(user) } })
  }

  const parsed = imageGenerationSchema.safeParse(request.body)
  if (!parsed.success) {
    return reply.status(400).send({ error: '图片生成参数不完整', detail: parsed.error.flatten() })
  }

  const body = {
    model: parsed.data.model ?? imageSkill.defaultModel,
    n: parsed.data.n,
    prompt: parsed.data.prompt,
    size: parsed.data.size ?? imageSkill.defaultSize,
  }

  if (parsed.data.async) {
    const job = startImageGenerationJob(user, body)
    return reply.status(202).send({ data: serializeImageGenerationJob(job) })
  }

  let result: Awaited<ReturnType<typeof completeImageGeneration>>
  try {
    result = await completeImageGeneration(user, body)
  } catch (error) {
    const message = error instanceof Error ? error.message : '图片生成失败'
    const status = message.includes('Token 额度不足') ? 402 : message.includes('没有返回 usage.total_tokens') ? 502 : 502
    return reply.status(status).send({ error: message })
  }

  return {
    data: {
      raw: result.raw,
      storageUrl: result.storageUrl,
      usageTokens: result.usageTokens,
      user: sanitizeUser(result.user),
    },
  }
})

app.get('/api/admin/skills/image/generations/:jobId', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  normalizeUser(user)

  const params = z.object({ jobId: z.string().min(1) }).parse(request.params)
  const job = imageGenerationJobs.get(params.jobId)
  if (!job || job.userId !== user.id) {
    return reply.status(404).send({ error: '图片生成任务不存在或已过期' })
  }

  return { data: serializeImageGenerationJob(job) }
})

app.post('/api/admin/skills/video/generations', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  normalizeUser(user)

  const parsed = videoGenerationSchema.safeParse(request.body)
  if (!parsed.success) {
    return reply.status(400).send({ error: '视频生成参数不完整', detail: parsed.error.flatten() })
  }

  const content = parsed.data.content?.length
    ? parsed.data.content
    : parsed.data.prompt
      ? [{ type: 'text', text: parsed.data.prompt }]
      : undefined

  if (!content?.length) {
    return reply.status(400).send({ error: '视频生成需要 prompt 或 content' })
  }

  if (user.tokenBudget - user.tokenUsed <= 0) {
    return reply.status(402).send({ error: 'Token 额度不足，请联系管理员派发额度', data: { user: sanitizeUser(user) } })
  }

  const duration = parsed.data.duration ?? videoSkill.defaultDuration
  const body = {
    ...parsed.data,
    content,
    duration,
    generate_audio: parsed.data.generate_audio ?? true,
    model: parsed.data.model ?? videoSkill.defaultModel,
    ratio: parsed.data.ratio ?? videoSkill.defaultRatio,
    resolution: parsed.data.resolution ?? videoSkill.defaultResolution,
    watermark: parsed.data.watermark ?? false,
  }
  delete (body as { prompt?: unknown }).prompt

  const upstream = await callVideoSkillApi(videoSkillTaskUrl(), {
    body: JSON.stringify(body),
    method: 'POST',
  })

  if (!upstream.ok) {
    const message = findFirstString(upstream.payload, ['message', 'error', 'msg']) ?? `火山方舟返回 ${upstream.status}`
    return reply.status(upstream.status).send({ error: message, upstream: upstream.payload })
  }

  const taskId = findFirstString(upstream.payload, ['id', 'task_id', 'taskId'])
  const status = findFirstString(upstream.payload, ['status'])
  const videoStatus = normalizedVideoStatus(status)
  const videoUrl = findFirstVideoUrl(upstream.payload)
  let usageTokens = 0
  if (taskId && videoStatus === 'completed') {
    const actualTokens = usageTotalTokens(upstream.payload)
    if (!actualTokens) {
      return reply.status(502).send({ error: '视频生成接口没有返回 usage.total_tokens，无法计费', upstream: upstream.payload })
    }
    try {
      usageTokens = chargeVideoTask(user, taskId, actualTokens).tokens
    } catch (error) {
      return reply.status(402).send({ error: error instanceof Error ? error.message : 'Token 额度不足，请联系管理员派发额度', data: { user: sanitizeUser(user) } })
    }
  }
  if (taskId) {
    upsertGeneratedAsset({
      user,
      type: 'video',
      taskId,
      prompt: parsed.data.prompt ?? promptFromVideoContent(content),
      model: body.model,
      provider: videoSkill.provider,
      status: videoStatus === 'completed' ? 'succeeded' : videoStatus === 'failed' ? 'failed' : 'running',
      tokenUsage: usageTokens,
      url: videoUrl ?? '',
      metadata: {
        duration: body.duration,
        ratio: body.ratio,
        resolution: body.resolution,
        status,
      },
    })
  }

  await persistStoredConfig()
  return {
    data: {
      taskId,
      status,
      videoUrl,
      raw: upstream.payload,
      usageTokens,
      user: sanitizeUser(user),
    },
  }
})

app.get('/api/admin/skills/video/generations/:taskId', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  normalizeUser(user)

  const params = z.object({ taskId: z.string().min(1) }).parse(request.params)
  const upstream = await callVideoSkillApi(videoSkillTaskUrl(params.taskId), { method: 'GET' })

  if (!upstream.ok) {
    const message = findFirstString(upstream.payload, ['message', 'error', 'msg']) ?? `火山方舟返回 ${upstream.status}`
    return reply.status(upstream.status).send({ error: message, upstream: upstream.payload })
  }

  const status = findFirstString(upstream.payload, ['status'])
  const videoStatus = normalizedVideoStatus(status)
  const videoUrl = findFirstVideoUrl(upstream.payload)
  let charge = findVideoCharge(params.taskId, user.id)
  if (videoStatus === 'completed') {
    const actualTokens = usageTotalTokens(upstream.payload) ?? charge?.tokens
    if (!actualTokens) {
      return reply.status(502).send({ error: '视频生成接口没有返回 usage.total_tokens，无法计费', upstream: upstream.payload })
    }
    try {
      charge = chargeVideoTask(user, params.taskId, actualTokens)
    } catch (error) {
      return reply.status(402).send({ error: error instanceof Error ? error.message : 'Token 额度不足，请联系管理员派发额度', data: { user: sanitizeUser(user) } })
    }
  }
  const existingAsset = generatedAssets.find((asset) => asset.taskId === params.taskId && asset.userId === user.id)
  if (existingAsset || videoUrl || videoStatus !== 'running') {
    upsertGeneratedAsset({
      user,
      type: 'video',
      taskId: params.taskId,
      prompt: existingAsset?.prompt ?? '',
      model: existingAsset?.model ?? findFirstString(upstream.payload, ['model']) ?? videoSkill.defaultModel,
      provider: videoSkill.provider,
      status: videoStatus === 'completed' ? 'succeeded' : videoStatus === 'failed' ? 'failed' : 'running',
      tokenUsage: charge?.tokens ?? existingAsset?.tokenUsage ?? 0,
      url: videoUrl ?? existingAsset?.url ?? '',
      metadata: {
        duration: (upstream.payload as { duration?: unknown })?.duration,
        ratio: (upstream.payload as { ratio?: unknown })?.ratio,
        resolution: (upstream.payload as { resolution?: unknown })?.resolution,
        status,
      },
    })
  }
  await persistStoredConfig()

  return {
    data: {
      taskId: params.taskId,
      status,
      videoUrl,
      raw: upstream.payload,
      usageTokens: charge?.tokens ?? 0,
      chargeStatus: charge?.status,
      user: sanitizeUser(user),
    },
  }
})

app.put('/api/admin/image-skill', async (request, reply) => {
  const parsed = imageSkillConfigSchema.safeParse(request.body)

  if (!parsed.success) {
    return reply.status(400).send({ error: '图片生成技能配置不完整', detail: parsed.error.flatten() })
  }

  if (parsed.data.apiKey?.trim()) {
    imageSkillApiKey = parsed.data.apiKey.trim()
  }

  if (parsed.data.enabled && !imageSkillApiKey) {
    return reply.status(400).send({ error: '启用图片技能前，请先配置 API Key' })
  }

  imageSkill = {
    id: 'gpt-image-2',
    name: 'gpt-image-2 图片生成',
    provider: 'openai-compatible-image',
    baseUrl: parsed.data.baseUrl,
    maskedApiKey: maskKey(imageSkillApiKey),
    apiKeyConfigured: Boolean(imageSkillApiKey),
    defaultModel: parsed.data.defaultModel,
    enabled: parsed.data.enabled,
    defaultSize: parsed.data.defaultSize,
    monthlyLimit: parsed.data.monthlyLimit,
  }

  await persistStoredConfig()

  return { data: imageSkill }
})

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

  const id = parsed.data.id?.trim() || createModelProviderId(parsed.data.name)
  if (parsed.data.apiKey?.trim()) {
    modelProviderApiKeys = { ...modelProviderApiKeys, [id]: parsed.data.apiKey.trim() }
  }

  const nextProvider: ModelProviderConfig = {
    id,
    name: parsed.data.name,
    baseUrl: parsed.data.baseUrl,
    maskedApiKey: maskKey(modelProviderApiKeys[id]),
    defaultModel: parsed.data.defaultModel,
    enabled: parsed.data.enabled,
    monthlyLimit: parsed.data.monthlyLimit,
  }

  modelProviders = [
    nextProvider,
    ...modelProviders.filter((provider) => provider.id !== id),
  ].map((provider) => ({
    ...provider,
    enabled: nextProvider.enabled ? provider.id === id : provider.enabled,
  }))
  refreshActiveModelProvider()
  await persistStoredConfig()

  return { data: { active: modelProvider, providers: modelProviders, provider: nextProvider } }
})

app.delete('/api/admin/model-provider/:id', async (request, reply) => {
  const params = z.object({ id: z.string().min(1) }).parse(request.params)

  if (modelProviders.length <= 1) {
    return reply.status(400).send({ error: '至少保留一个模型通道' })
  }

  const removed = modelProviders.find((provider) => provider.id === params.id)
  if (!removed) return reply.status(404).send({ error: '模型通道不存在' })

  modelProviders = modelProviders.filter((provider) => provider.id !== params.id)
  delete modelProviderApiKeys[params.id]
  if (removed.enabled && modelProviders.length) {
    modelProviders = modelProviders.map((provider, index) => ({ ...provider, enabled: index === 0 }))
  }
  refreshActiveModelProvider()
  await persistStoredConfig()

  return { data: { active: modelProvider, providers: modelProviders } }
})

app.get('/api/admin/employees', async () => ({
  data: employees,
  sources: ['企业微信', '飞书', '钉钉'],
}))

app.get('/api/admin/policy', async () => ({ data: policy }))

app.get('/api/desktop/bootstrap', async () => ({
  data: buildDesktopBootstrap(),
}))

const port = Number(process.env.API_PORT ?? 4000)
const host = process.env.API_HOST ?? '0.0.0.0'
await app.listen({ host, port })
