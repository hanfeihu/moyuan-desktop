import cors from '@fastify/cors'
import 'dotenv/config'
import Fastify from 'fastify'
import nodemailer from 'nodemailer'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AccountUser, Employee, EnterprisePolicy, MailServiceConfig, ModelProviderConfig, VideoSkillConfig } from '@eaw/shared'

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

const mailConfigSchema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().email(),
  fromName: z.string().min(1),
  authCode: z.string().optional(),
  enabled: z.boolean(),
})

const sendCodeSchema = z.object({
  email: z.string().email(),
})

const authSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
  name: z.string().optional(),
})

const usageSchema = z.object({
  promptTokens: z.coerce.number().int().min(0).default(0),
  completionTokens: z.coerce.number().int().min(0).default(0),
  totalTokens: z.coerce.number().int().min(0).optional(),
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
  videoSkillApiKey?: string
  videoSkill?: Omit<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>
  mailAuthCode?: string
  mailSettings?: Omit<MailServiceConfig, 'maskedAuthCode' | 'authCodeConfigured'>
  users?: AccountUser[]
  sessions?: Array<{ tokenHash: string; userId: string; createdAt: string; lastSeenAt: string }>
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
let mailAuthCode = storedConfig.mailAuthCode ?? process.env.QQ_MAIL_AUTH_CODE ?? ''
let mailSettings: MailServiceConfig = buildMailSettings(storedConfig.mailSettings)
let users: AccountUser[] = storedConfig.users ?? []
let sessions = storedConfig.sessions ?? []
const verificationCodes = new Map<string, { code: string; expiresAt: number; createdAt: number }>()

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
        mailSettings,
        mailAuthCode,
        users,
        sessions,
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

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function sanitizeUser(user: AccountUser): AccountUser {
  return { ...user }
}

function createSession(userId: string) {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
  const now = new Date().toISOString()
  sessions = [{ tokenHash: tokenHash(token), userId, createdAt: now, lastSeenAt: now }, ...sessions].slice(0, 500)
  void persistStoredConfig()
  return token
}

function getAuthToken(request: { headers: Record<string, unknown> }) {
  const authHeader = String(request.headers.authorization ?? '')
  if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length)
  return String(request.headers['x-moyuan-auth-token'] ?? '')
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

app.get('/health', async () => ({
  ok: true,
  service: 'enterprise-api',
}))

app.get('/api/admin/model-provider', async () => ({ data: modelProvider }))

app.get('/api/admin/video-skill', async () => ({ data: videoSkill }))

app.get('/api/admin/mail-settings', async () => ({ data: mailSettings }))

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

app.get('/api/admin/users', async () => ({ data: users.map(sanitizeUser) }))

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
  await persistStoredConfig()
  return { data: { user: sanitizeUser(user) } }
})

app.post('/api/admin/me/usage', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)
  const parsed = usageSchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: '用量数据不完整' })

  const promptTokens = parsed.data.promptTokens
  const completionTokens = parsed.data.completionTokens
  const totalTokens = parsed.data.totalTokens ?? promptTokens + completionTokens
  const remainingTokens = user.tokenBudget - user.tokenUsed
  if (totalTokens > remainingTokens) {
    return reply.status(402).send({ error: 'Token 额度不足，请联系管理员派发额度', data: { user: sanitizeUser(user) } })
  }
  user.promptTokens += promptTokens
  user.completionTokens += completionTokens
  user.tokenUsed += totalTokens
  await persistStoredConfig()
  return { data: { user: sanitizeUser(user) } }
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
