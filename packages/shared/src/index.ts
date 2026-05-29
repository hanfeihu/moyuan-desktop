export type OrgSource = 'wecom' | 'lark' | 'dingtalk'

export type ConnectorStatus = 'connected' | 'pending' | 'disabled'

export type ModelProviderConfig = {
  id: string
  name: string
  baseUrl: string
  maskedApiKey: string
  defaultModel: string
  enabled: boolean
  monthlyLimit: number
}

export const videoRatioOptions = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9'] as const
export type VideoRatio = (typeof videoRatioOptions)[number]

export const videoResolutionOptions = ['480p', '720p', '1080p'] as const
export type VideoResolution = (typeof videoResolutionOptions)[number]

export function isAdaptiveVideoRatioModel(model?: string) {
  const normalized = (model ?? '').toLowerCase().replace(/[_.\s]+/g, '-')
  return normalized.includes('seedance-2') || normalized.includes('seedance-1-5-pro')
}

export function defaultVideoRatioForModel(model?: string): VideoRatio {
  return isAdaptiveVideoRatioModel(model) ? 'adaptive' : '16:9'
}

export type VideoSkillConfig = {
  id: string
  name: string
  provider: 'volcengine-ark'
  baseUrl: string
  maskedApiKey: string
  apiKeyConfigured: boolean
  defaultModel: string
  enabled: boolean
  allowImageInput: boolean
  defaultDuration: number
  defaultRatio: VideoRatio
  defaultResolution: VideoResolution
  monthlyLimit: number
}

export type ImageSkillConfig = {
  id: string
  name: string
  provider: 'openai-compatible-image'
  baseUrl: string
  maskedApiKey: string
  apiKeyConfigured: boolean
  defaultModel: string
  enabled: boolean
  defaultSize: '1024x1024' | '1024x1536' | '1536x1024'
  monthlyLimit: number
}

export type MailServiceConfig = {
  smtpHost: string
  smtpPort: number
  secure: boolean
  username: string
  fromName: string
  maskedAuthCode: string
  authCodeConfigured: boolean
  enabled: boolean
}

export type PaymentProvider = 'zpayz'

export type PaymentGatewayConfig = {
  id: string
  name: string
  provider: PaymentProvider
  gatewayUrl: string
  pid: string
  maskedKey: string
  keyConfigured: boolean
  enabled: boolean
  supportedMethods: Array<'alipay' | 'wxpay'>
}

export type TokenPlan = {
  id: string
  name: string
  description: string
  price: number
  tokens: number
  enabled: boolean
  sort: number
  createdAt: string
  updatedAt: string
}

export type RechargeOrder = {
  id: string
  userEmail: string
  userId: string
  userName: string
  planId: string
  planName: string
  tokens: number
  amount: number
  provider: PaymentProvider
  method: 'alipay' | 'wxpay'
  status: 'pending' | 'paid' | 'failed' | 'closed'
  outTradeNo: string
  tradeNo?: string
  payUrl?: string
  createdAt: string
  updatedAt: string
  paidAt?: string
}

export type AccountUser = {
  id: string
  email: string
  name: string
  status: 'active' | 'disabled'
  tokenBudget: number
  tokenUsed: number
  promptTokens: number
  completionTokens: number
  skillTokens: number
  quotaUpdatedAt?: string
  createdAt: string
  lastLoginAt?: string
}

export type EnterprisePolicy = {
  dataBoundary: 'local' | 'hybrid'
  auditEnabled: boolean
  externalSharing: 'blocked' | 'approval' | 'allowed'
  highRiskToolMode: 'approval' | 'blocked'
}

export type Employee = {
  id: string
  name: string
  department: string
  title: string
  source: OrgSource
  manager: string
}

export type CodexTask = {
  id: string
  title: string
  status: 'queued' | 'running' | 'needs_approval' | 'completed' | 'failed'
  workspace: string
  sessionId?: string
  forkedFrom?: string
  workspaceMemory?: string
  commandHistory?: string[]
  diffSummary?: string
  createdAt?: string
  updatedAt?: string
  exitCode?: number | null
  generatedImages?: ImageGenerationResult[]
  generatedVideos?: VideoGenerationResult[]
  transcript: Array<{
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    timestamp: string
    eventId?: string
    itemId?: string
    seq?: number
    turnId?: string
  }>
}

export type ImageGenerationResult = {
  id: string
  prompt: string
  model: string
  size: string
  url: string
  usageTokens?: number
  createdAt: string
}

export type VideoGenerationResult = {
  id: string
  prompt: string
  model: string
  url: string
  duration?: number
  ratio?: string
  resolution?: string
  usageTokens?: number
  createdAt: string
}

export type GeneratedAssetRecord = {
  id: string
  userEmail: string
  userId: string
  userName: string
  type: 'image' | 'video'
  prompt: string
  model: string
  url: string
  storageUrl?: string
  taskId?: string
  status: 'running' | 'succeeded' | 'failed'
  tokenUsage: number
  provider: string
  metadata?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ClientLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type ClientLogRecord = {
  id: string
  userId?: string
  userEmail?: string
  userName?: string
  deviceId: string
  deviceName?: string
  platform: string
  osVersion?: string
  appVersion?: string
  source: string
  level: ClientLogLevel
  event: string
  details?: unknown
  taskId?: string
  sessionId?: string
  workspace?: string
  ip?: string
  userAgent?: string
  createdAt: string
  receivedAt: string
}

export type CodexTaskEvent = {
  id: string
  taskId: string
  type: 'thread.started' | 'turn.started' | 'message' | 'message_delta' | 'tool' | 'error' | 'turn.completed' | 'turn.failed' | 'process.exit'
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  timestamp: string
  seq?: number
  itemId?: string
  turnId?: string
  raw?: unknown
}

export {
  compactAssistantTranscript,
  finalAssistantContent,
  friendlyRuntimeMessage,
  isRuntimeFailureNotice,
  mergeAssistantContent,
  runtimeFailureDiagnostic,
  type CodexTranscriptItem,
} from './task-normalization.js'
