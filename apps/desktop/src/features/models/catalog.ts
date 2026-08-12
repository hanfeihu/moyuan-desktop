import { normalizeModelCatalog, type ModelCatalogEntry } from '@eaw/shared'
import { enterpriseFetch } from '../../api'

type DesktopBootstrapPayload = {
  data?: {
    runtime?: {
      modelProvider?: {
        defaultModel?: string
        enabled?: boolean
        models?: ModelCatalogEntry[]
      }
    }
  }
  error?: string
}

export async function loadModelCatalog(authToken: string) {
  const response = await enterpriseFetch('/desktop/bootstrap', authToken, { timeoutMs: 8000 })
  const payload = (await response.json()) as DesktopBootstrapPayload
  if (!response.ok) throw new Error(payload.error ?? '模型目录加载失败')
  const provider = payload.data?.runtime?.modelProvider
  if (!provider?.defaultModel) throw new Error('后台没有下发模型目录')
  if (provider?.enabled === false) throw new Error('当前没有启用的模型通道')
  return {
    defaultModel: provider.defaultModel,
    models: normalizeModelCatalog(provider.models, provider.defaultModel)
      .filter((model) => model.enabled),
  }
}
