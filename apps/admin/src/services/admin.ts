import type { Employee, EnterprisePolicy, ModelProviderConfig, VideoSkillConfig } from '@eaw/shared'
import { defaultEmployees, defaultPolicy, defaultProviders, defaultVideoSkill } from '@/data/defaults'

const apiBase = '/admin-api'

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
  videoSkill: VideoSkillConfig
}

type AdminPayload<T> = {
  data: T
}

async function getJson<T>(path: string) {
  const response = await fetch(`${apiBase}${path}`)
  if (!response.ok) throw new Error(`request failed: ${response.status}`)
  return (await response.json()) as AdminPayload<T>
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
    const [modelPayload, employeePayload, policyPayload, videoSkillPayload] = await Promise.all([
      getJson<ModelProviderConfig>('/model-provider'),
      getJson<Employee[]>('/employees'),
      getJson<EnterprisePolicy>('/policy'),
      getJson<VideoSkillConfig>('/video-skill'),
    ])
    const providers = [modelPayload.data, ...defaultProviders.filter((item) => item.id !== modelPayload.data.id)]
    return {
      apiState: 'online',
      employees: employeePayload.data,
      modelProvider: modelPayload.data,
      policy: policyText(policyPayload.data),
      providers,
      videoSkill: videoSkillPayload.data,
    }
  } catch {
    return {
      apiState: 'offline',
      employees: defaultEmployees,
      modelProvider: defaultProviders[0],
      policy: defaultPolicy,
      providers: defaultProviders,
      videoSkill: defaultVideoSkill,
    }
  }
}

export async function saveModelProvider(values: Record<string, unknown>) {
  const response = await fetch(`${apiBase}/model-provider`, {
    body: JSON.stringify({
      apiKey: values.apiKey || 'configured-in-admin',
      baseUrl: values.baseUrl,
      defaultModel: values.defaultModel,
      enabled: Boolean(values.enabled),
      name: values.provider === 'local' ? '本地私有模型' : 'Blector 中转',
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'PUT',
  })
  const payload = (await response.json()) as { data?: ModelProviderConfig; error?: string }
  if (!response.ok || !payload.data) throw new Error(payload.error ?? '保存失败')
  return payload.data
}

export async function saveVideoSkill(values: Record<string, unknown>) {
  const response = await fetch(`${apiBase}/video-skill`, {
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
  return payload.data
}
