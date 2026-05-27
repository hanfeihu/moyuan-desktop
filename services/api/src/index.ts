import cors from '@fastify/cors'
import 'dotenv/config'
import Fastify from 'fastify'
import nodemailer from 'nodemailer'
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
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

const videoGenerationSchema = z
  .object({
    content: z.array(z.unknown()).optional(),
    duration: z.coerce.number().int().min(1).max(30).optional(),
    generate_audio: z.boolean().optional(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    ratio: z.string().optional(),
    watermark: z.boolean().optional(),
  })
  .passthrough()

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

const adminAuthSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
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
  adminAuth?: AdminAuthConfig
  adminSessions?: AdminSession[]
  videoSkillApiKey?: string
  videoSkill?: Omit<VideoSkillConfig, 'maskedApiKey' | 'apiKeyConfigured'>
  mailAuthCode?: string
  mailSettings?: Omit<MailServiceConfig, 'maskedAuthCode' | 'authCodeConfigured'>
  users?: AccountUser[]
  sessions?: Array<{ tokenHash: string; userId: string; createdAt: string; lastSeenAt: string }>
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
let adminAuth: AdminAuthConfig | undefined = storedConfig.adminAuth ?? buildAdminAuthFromEnv()
let adminSessions: AdminSession[] = storedConfig.adminSessions ?? []
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
        adminAuth,
        adminSessions,
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
  if (pathname.startsWith('/api/admin/skills/')) return
  if (pathname === '/api/admin/desktop/bootstrap') return
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
  }
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

app.get('/api/admin/video-skill', async () => ({ data: videoSkill }))

app.get('/api/admin/mail-settings', async () => ({ data: mailSettings }))

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

app.post('/api/admin/skills/video/generations', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)

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

  const body = {
    ...parsed.data,
    content,
    duration: parsed.data.duration ?? videoSkill.defaultDuration,
    generate_audio: parsed.data.generate_audio ?? true,
    model: parsed.data.model ?? videoSkill.defaultModel,
    ratio: parsed.data.ratio ?? videoSkill.defaultRatio,
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
  return {
    data: {
      taskId,
      status: findFirstString(upstream.payload, ['status']),
      videoUrl: findFirstVideoUrl(upstream.payload),
      raw: upstream.payload,
    },
  }
})

app.get('/api/admin/skills/video/generations/:taskId', async (request, reply) => {
  const user = getRequestUser(request)
  if (!user) return unauthorized(reply)

  const params = z.object({ taskId: z.string().min(1) }).parse(request.params)
  const upstream = await callVideoSkillApi(videoSkillTaskUrl(params.taskId), { method: 'GET' })

  if (!upstream.ok) {
    const message = findFirstString(upstream.payload, ['message', 'error', 'msg']) ?? `火山方舟返回 ${upstream.status}`
    return reply.status(upstream.status).send({ error: message, upstream: upstream.payload })
  }

  return {
    data: {
      taskId: params.taskId,
      status: findFirstString(upstream.payload, ['status']),
      videoUrl: findFirstVideoUrl(upstream.payload),
      raw: upstream.payload,
    },
  }
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
  data: buildDesktopBootstrap(),
}))

const port = Number(process.env.API_PORT ?? 4000)
const host = process.env.API_HOST ?? '0.0.0.0'
await app.listen({ host, port })
