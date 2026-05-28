export const defaultEnterpriseApiBase = process.env.ENTERPRISE_API_BASE ?? 'http://codex.tminos.com:18080/admin-api'

export type ModelRuntimeConfig = {
  providerId: string
  providerName: string
  baseUrl: string
  apiKeyConfigured: boolean
  apiKey?: string
  envKey: 'OPENAI_API_KEY'
  defaultModel: string
}

export function getModelConfig(): ModelRuntimeConfig {
  return {
    providerId: process.env.AI_PROVIDER_ID ?? 'moyuan-blector',
    providerName: process.env.AI_PROVIDER_NAME ?? 'Moyuan OpenAI Compatible Proxy',
    baseUrl: process.env.AI_BASE_URL ?? 'https://ai.blector.com/v1',
    apiKeyConfigured: Boolean(process.env.AI_API_KEY),
    apiKey: process.env.AI_API_KEY,
    envKey: 'OPENAI_API_KEY',
    defaultModel: process.env.AI_MODEL ?? 'gpt-5.5',
  }
}

export function getImageConfig() {
  return {
    baseUrl: process.env.IMAGE_BASE_URL ?? 'https://codex-manager.tminos.com/v1',
    apiKeyConfigured: Boolean(process.env.IMAGE_API_KEY),
    defaultModel: process.env.IMAGE_MODEL ?? 'gpt-image-2',
  }
}
