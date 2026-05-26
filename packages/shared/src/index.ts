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
  transcript: Array<{
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    timestamp: string
  }>
}
