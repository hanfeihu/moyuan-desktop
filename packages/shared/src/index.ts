export type OrgSource = 'wecom' | 'lark' | 'dingtalk'

export type ConnectorStatus = 'connected' | 'pending' | 'disabled'

export type ModelProviderConfig = {
  id: string
  name: string
  baseUrl: string
  maskedApiKey: string
  defaultModel: string
  enabled: boolean
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
  defaultRatio: string
  defaultResolution: string
  monthlyLimit: number
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
  transcript: Array<{
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    timestamp: string
  }>
}

export type ImageGenerationResult = {
  id: string
  prompt: string
  model: string
  size: string
  url: string
  createdAt: string
}

export type CodexTaskEvent = {
  id: string
  taskId: string
  type: 'thread.started' | 'turn.started' | 'message' | 'message_delta' | 'tool' | 'error' | 'turn.completed' | 'turn.failed' | 'process.exit'
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  timestamp: string
  raw?: unknown
}
