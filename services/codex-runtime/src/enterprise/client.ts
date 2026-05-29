import { defaultEnterpriseApiBase, getModelConfig, type ModelRuntimeConfig } from '../config.js'
import { localSkillSet } from '../skills/catalog.js'
import type { EnterpriseSkillSet } from '../skills/contracts.js'

type EnterpriseMeResponse = {
  data?: {
    user?: {
      tokenBudget: number
      tokenUsed: number
      status: string
    }
  }
  error?: string
}

export function enterpriseEndpoint(baseUrl: string, pathname: string) {
  return `${baseUrl.replace(/\/$/, '')}/${pathname.replace(/^\//, '')}`
}

function providerId(value?: string) {
  const normalized = (value ?? 'moyuan-enterprise')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'moyuan-enterprise'
}

function modelProxyBaseUrl(baseUrl: string) {
  return enterpriseEndpoint(baseUrl, '/model-proxy/v1')
}

export async function loadEnterpriseRuntimeConfig(
  authToken?: string,
  baseUrl = defaultEnterpriseApiBase,
): Promise<{ skills: EnterpriseSkillSet; modelConfig: ModelRuntimeConfig }> {
  const skills = localSkillSet()
  let modelConfig = getModelConfig()
  if (!authToken) return { skills, modelConfig }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(enterpriseEndpoint(baseUrl, '/desktop/bootstrap'), {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => ({}))) as {
      data?: {
        runtime?: {
          modelProvider?: {
            id?: string
            name?: string
            defaultModel?: string
            enabled?: boolean
          }
          skills?: {
            imageGeneration?: EnterpriseSkillSet['imageGeneration']
            videoGeneration?: EnterpriseSkillSet['videoGeneration']
          }
          plugins?: EnterpriseSkillSet['plugins']
        }
      }
    }
    const imageGeneration = payload.data?.runtime?.skills?.imageGeneration
    const videoGeneration = payload.data?.runtime?.skills?.videoGeneration
    const plugins = payload.data?.runtime?.plugins
    if (response.ok && imageGeneration) {
      skills.imageGeneration = imageGeneration
    }
    if (response.ok && videoGeneration) {
      skills.videoGeneration = videoGeneration
    }
    if (response.ok && plugins) {
      skills.plugins = plugins
    }
    const modelProvider = payload.data?.runtime?.modelProvider
    if (response.ok && modelProvider?.enabled !== false && modelProvider?.defaultModel) {
      modelConfig = {
        providerId: providerId(modelProvider.id ?? modelProvider.name),
        providerName: modelProvider.name ?? 'Moyuan Enterprise Model Proxy',
        baseUrl: modelProxyBaseUrl(baseUrl),
        apiKeyConfigured: true,
        apiKey: authToken,
        envKey: 'OPENAI_API_KEY',
        defaultModel: modelProvider.defaultModel,
      }
    }
  } catch {
    // Keep local tools available if the enterprise bootstrap endpoint is temporarily unavailable.
  } finally {
    clearTimeout(timeout)
  }

  return { skills, modelConfig }
}

export async function loadEnterpriseSkillSet(authToken?: string, baseUrl = defaultEnterpriseApiBase): Promise<EnterpriseSkillSet> {
  return (await loadEnterpriseRuntimeConfig(authToken, baseUrl)).skills
}

export async function validateEnterpriseQuota(authToken?: string, baseUrl = defaultEnterpriseApiBase) {
  if (!authToken) return { ok: false, statusCode: 401, error: '请先登录墨渊账号' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(enterpriseEndpoint(baseUrl, '/me'), {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    })
    const payload = (await response.json().catch(() => ({}))) as EnterpriseMeResponse
    if (!response.ok || !payload.data?.user) {
      return { ok: false, statusCode: response.status || 401, error: payload.error ?? '登录状态已失效，请重新登录' }
    }

    const user = payload.data.user
    if (user.status !== 'active') return { ok: false, statusCode: 403, error: '账号已停用，请联系管理员' }
    if (user.tokenBudget - user.tokenUsed <= 0) {
      return { ok: false, statusCode: 402, error: 'Token 额度不足，请联系管理员派发额度' }
    }

    return { ok: true }
  } catch {
    return { ok: false, statusCode: 503, error: '企业后台暂时不可用，无法校验 Token 额度' }
  } finally {
    clearTimeout(timeout)
  }
}

export async function enterpriseJson(pathname: string, authToken: string, baseUrl: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 30000, ...requestInit } = init
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const response = await fetch(enterpriseEndpoint(baseUrl, pathname), {
    ...requestInit,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      ...(requestInit.headers ?? {}),
    },
    signal: requestInit.signal ?? controller.signal,
  })
  try {
    const payload = (await response.json().catch(() => ({}))) as { data?: unknown; error?: string; message?: string; upstream?: unknown }
    if (!response.ok) {
      throw new Error(payload.error ?? payload.message ?? `企业技能代理返回 ${response.status}`)
    }
    return payload.data
  } finally {
    clearTimeout(timeout)
  }
}
