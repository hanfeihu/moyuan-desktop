import type { AccountUser, ClientLogRecord, Employee, EnterprisePolicy, GeneratedAssetRecord, ImageSkillConfig, MailServiceConfig, ModelProviderConfig, VideoSkillConfig } from '@eaw/shared'
import { defaultEmployees, defaultImageSkill, defaultMailSettings, defaultPolicy, defaultProviders, defaultVideoSkill } from '@/data/defaults'

const apiBase = '/admin-api'
const adminTokenStorageKey = 'moyuan.admin.token'

export type ApiState = 'checking' | 'online' | 'offline'

export type PolicyView = {
  dataBoundary: string
  externalSharing: string
  highRiskTool: string
  retention: string
}

export type AdminSnapshot = {
  apiState: ApiState
  employees: Employee[]
  modelProvider: ModelProviderConfig
  policy: PolicyView
  providers: ModelProviderConfig[]
  imageSkill: ImageSkillConfig
  videoSkill: VideoSkillConfig
}

type AdminPayload<T> = {
  data: T
}

export type AdminAuthState = {
  configured: boolean
  username: string
}

function normalizeImageSkill(skill?: Partial<ImageSkillConfig> | null): ImageSkillConfig {
  return {
    ...defaultImageSkill,
    ...skill,
    apiKeyConfigured: skill?.apiKeyConfigured ?? defaultImageSkill.apiKeyConfigured,
    maskedApiKey: skill?.maskedApiKey ?? defaultImageSkill.maskedApiKey,
  }
}

function normalizeVideoSkill(skill?: Partial<VideoSkillConfig> | null): VideoSkillConfig {
  return {
    ...defaultVideoSkill,
    ...skill,
    apiKeyConfigured: skill?.apiKeyConfigured ?? defaultVideoSkill.apiKeyConfigured,
    maskedApiKey: skill?.maskedApiKey ?? defaultVideoSkill.maskedApiKey,
  }
}

function normalizeProvider(provider: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    id: provider.id ?? 'blector',
    name: provider.name ?? 'Blector 中转',
    baseUrl: provider.baseUrl ?? 'https://ai.blector.com/v1',
    maskedApiKey: provider.maskedApiKey ?? '未配置',
    defaultModel: provider.defaultModel ?? 'gpt-5.5',
    enabled: provider.enabled ?? false,
    monthlyLimit: provider.monthlyLimit ?? 5000000,
  }
}

export function getAdminToken() {
  if (typeof window === 'undefined') return ''
  return window.localStorage.getItem(adminTokenStorageKey) ?? ''
}

export function setAdminToken(token: string) {
  window.localStorage.setItem(adminTokenStorageKey, token)
}

export function clearAdminToken() {
  window.localStorage.removeItem(adminTokenStorageKey)
}

export function isAdminSignedIn() {
  return Boolean(getAdminToken())
}

function redirectToLogin() {
  if (typeof window === 'undefined') return
  if (!window.location.pathname.endsWith('/admin/login') && !window.location.pathname.endsWith('/login')) {
    window.location.assign('/admin/login')
  }
}

async function adminFetch(path: string, init: RequestInit = {}, auth = true) {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const token = getAdminToken()
  if (auth && token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  if (auth && response.status === 401) {
    clearAdminToken()
    redirectToLogin()
  }
  return response
}

async function getJson<T>(path: string) {
  const response = await adminFetch(path)
  if (!response.ok) throw new Error(`request failed: ${response.status}`)
  return (await response.json()) as AdminPayload<T>
}

export async function loadAdminAuthState() {
  const response = await adminFetch('/admin-auth/state', {}, false)
  const payload = (await response.json()) as { data?: AdminAuthState; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '无法读取管理员状态')
  return payload.data
}

export async function loginAdmin(values: { password: string; username: string }) {
  const response = await adminFetch('/admin-auth/login', {
    body: JSON.stringify(values),
    method: 'POST',
  }, false)
  const payload = (await response.json()) as { data?: { token: string; username: string }; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '登录失败')
  setAdminToken(payload.data.token)
  return payload.data
}

export async function setupAdmin(values: { password: string; username: string }) {
  const response = await adminFetch('/admin-auth/setup', {
    body: JSON.stringify(values),
    method: 'POST',
  }, false)
  const payload = (await response.json()) as { data?: { token: string; username: string }; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '初始化失败')
  setAdminToken(payload.data.token)
  return payload.data
}

export async function loadAdminMe() {
  const payload = await getJson<{ username: string }>('/admin-auth/me')
  return payload.data
}

export function policyText(policy: EnterprisePolicy): PolicyView {
  return {
    dataBoundary: policy.dataBoundary === 'hybrid' ? '本地 + 企业服务' : '企业内网',
    externalSharing:
      policy.externalSharing === 'blocked' ? '禁止外发' : policy.externalSharing === 'allowed' ? '允许外发' : '外发需审批',
    highRiskTool: policy.highRiskToolMode === 'blocked' ? '默认禁止' : '默认人工确认',
    retention: policy.auditEnabled ? '审计保留 180 天' : '未启用审计',
  }
}

export async function loadAdminSnapshot(): Promise<AdminSnapshot> {
  try {
    const [modelPayload, providersPayload, employeePayload, policyPayload, imageSkillPayload, videoSkillPayload] = await Promise.all([
      getJson<ModelProviderConfig>('/model-provider'),
      getJson<ModelProviderConfig[]>('/model-providers'),
      getJson<Employee[]>('/employees'),
      getJson<EnterprisePolicy>('/policy'),
      getJson<ImageSkillConfig>('/image-skill'),
      getJson<VideoSkillConfig>('/video-skill'),
    ])
    const providers = providersPayload.data.length ? providersPayload.data.map(normalizeProvider) : [normalizeProvider(modelPayload.data)]
    const modelProvider = providers.find((item) => item.enabled) ?? normalizeProvider(modelPayload.data)
    return {
      apiState: 'online',
      employees: employeePayload.data,
      modelProvider,
      policy: policyText(policyPayload.data),
      providers,
      imageSkill: normalizeImageSkill(imageSkillPayload.data),
      videoSkill: normalizeVideoSkill(videoSkillPayload.data),
    }
  } catch {
    return {
      apiState: 'offline',
      employees: defaultEmployees,
      modelProvider: defaultProviders[0],
      policy: defaultPolicy,
      providers: defaultProviders,
      imageSkill: defaultImageSkill,
      videoSkill: defaultVideoSkill,
    }
  }
}

export async function saveModelProvider(values: Record<string, unknown>) {
  const response = await adminFetch('/model-provider', {
    body: JSON.stringify({
      id: values.id,
      apiKey: values.apiKey,
      baseUrl: values.baseUrl,
      defaultModel: values.defaultModel,
      enabled: Boolean(values.enabled),
      monthlyLimit: values.monthlyLimit,
      name: values.name,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
  const payload = (await response.json()) as { data?: { active: ModelProviderConfig; provider: ModelProviderConfig; providers: ModelProviderConfig[] }; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '保存失败')
  return {
    active: normalizeProvider(payload.data.active),
    provider: normalizeProvider(payload.data.provider),
    providers: payload.data.providers.map(normalizeProvider),
  }
}

export async function deleteModelProvider(id: string) {
  const response = await adminFetch(`/model-provider/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  const payload = (await response.json()) as { data?: { active: ModelProviderConfig; providers: ModelProviderConfig[] }; error?: string; message?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? payload.message ?? '删除失败')
  return {
    active: normalizeProvider(payload.data.active),
    providers: payload.data.providers.map(normalizeProvider),
  }
}

export async function saveVideoSkill(values: Record<string, unknown>) {
  const response = await adminFetch('/video-skill', {
    body: JSON.stringify({
      allowImageInput: Boolean(values.allowImageInput),
      apiKey: values.apiKey,
      baseUrl: values.baseUrl,
      defaultDuration: values.defaultDuration,
      defaultModel: values.defaultModel,
      defaultRatio: values.defaultRatio,
      defaultResolution: values.defaultResolution,
      enabled: Boolean(values.enabled),
      monthlyLimit: values.monthlyLimit,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
  const payload = (await response.json()) as { data?: VideoSkillConfig; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '保存失败')
  return normalizeVideoSkill(payload.data)
}

export async function loadAssets() {
  try {
    const payload = await getJson<GeneratedAssetRecord[]>('/generated-assets')
    return payload.data
  } catch {
    return []
  }
}

export async function loadClientLogs(params: { deviceId?: string; event?: string; level?: string; limit?: number; userId?: string } = {}) {
  try {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== '') search.set(key, String(value))
    })
    const payload = await getJson<ClientLogRecord[]>(`/client-logs${search.size ? `?${search.toString()}` : ''}`)
    return payload.data
  } catch {
    return []
  }
}

export async function saveImageSkill(values: Record<string, unknown>) {
  const response = await adminFetch('/image-skill', {
    body: JSON.stringify({
      apiKey: values.apiKey,
      baseUrl: values.baseUrl,
      defaultModel: values.defaultModel,
      defaultSize: values.defaultSize,
      enabled: Boolean(values.enabled),
      monthlyLimit: values.monthlyLimit,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
  const payload = (await response.json()) as { data?: ImageSkillConfig; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '保存失败')
  return normalizeImageSkill(payload.data)
}

export async function loadMailSettings() {
  try {
    const payload = await getJson<MailServiceConfig>('/mail-settings')
    return payload.data
  } catch {
    return defaultMailSettings
  }
}

export async function saveMailSettings(values: Record<string, unknown>) {
  const response = await adminFetch('/mail-settings', {
    body: JSON.stringify({
      authCode: values.authCode,
      enabled: Boolean(values.enabled),
      fromName: values.fromName,
      secure: Boolean(values.secure),
      smtpHost: values.smtpHost,
      smtpPort: values.smtpPort,
      username: values.username,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
  const payload = (await response.json()) as { data?: MailServiceConfig; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '保存失败')
  return payload.data
}

export async function sendTestMail() {
  const response = await adminFetch('/mail-settings/test', {
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const payload = (await response.json()) as { data?: { sent: boolean }; error?: string }
  if (!response.ok || !payload.data?.sent) throw new Error(payload.error ?? '测试邮件发送失败')
  return payload.data
}

export async function loadUsers() {
  try {
    const payload = await getJson<AccountUser[]>('/users')
    return payload.data
  } catch {
    return []
  }
}

export async function saveUserQuota(userId: string, values: { amount: number; mode: 'grant' | 'set' }) {
  const response = await adminFetch(`/users/${encodeURIComponent(userId)}/quota`, {
    body: JSON.stringify(values),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
  const payload = (await response.json()) as { data?: AccountUser; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '额度保存失败')
  return payload.data
}

export async function sendAuthCode(email: string) {
  const response = await adminFetch('/auth/send-code', {
    body: JSON.stringify({ email }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }, false)
  const payload = (await response.json()) as { data?: { sent: boolean }; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '验证码发送失败')
  return payload.data
}

export async function authWithCode(mode: 'login' | 'register', values: { email: string; code: string; name?: string }) {
  const response = await adminFetch(`/auth/${mode}`, {
    body: JSON.stringify(values),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }, false)
  const payload = (await response.json()) as { data?: { token: string; user: AccountUser }; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '登录失败')
  return payload.data
}
