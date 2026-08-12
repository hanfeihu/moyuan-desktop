export type OrgSource = 'wecom' | 'lark' | 'dingtalk'

export type ConnectorStatus = 'connected' | 'pending' | 'disabled'

export const reasoningEffortValues = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type ReasoningEffort = (typeof reasoningEffortValues)[number]

export type ModelCatalogEntry = {
  id: string
  displayName: string
  description?: string
  enabled: boolean
  defaultReasoningEffort: ReasoningEffort
  supportedReasoningEfforts: ReasoningEffort[]
}

export const defaultCodexModelId = 'gpt-5.6-sol'
export const defaultCodexReasoningEffort: ReasoningEffort = 'xhigh'

export const defaultCodexModelCatalog: ModelCatalogEntry[] = [
  {
    id: defaultCodexModelId,
    displayName: '5.6 Sol',
    description: '复杂编码与高质量任务',
    enabled: true,
    defaultReasoningEffort: defaultCodexReasoningEffort,
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
]

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && reasoningEffortValues.includes(value as ReasoningEffort)
}

export function modelDisplayName(modelId: string) {
  const match = modelId.trim().match(/^gpt-(\d+(?:\.\d+)?)(?:-(.+))?$/i)
  if (!match) return modelId.trim()
  const suffix = match[2]
    ? ` ${match[2].split('-').map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(' ')}`
    : ''
  return `${match[1]}${suffix}`
}

export function normalizeModelCatalog(
  models: ReadonlyArray<Partial<ModelCatalogEntry>> | null | undefined,
  defaultModel = defaultCodexModelId,
): ModelCatalogEntry[] {
  const seen = new Set<string>()
  const normalized = (models ?? []).flatMap((model) => {
    const id = model.id?.trim()
    if (!id || seen.has(id)) return []
    seen.add(id)
    const supportedReasoningEfforts = (model.supportedReasoningEfforts ?? []).filter(isReasoningEffort)
    const efforts = supportedReasoningEfforts.length ? Array.from(new Set(supportedReasoningEfforts)) : ['low', 'medium', 'high', 'xhigh'] satisfies ReasoningEffort[]
    const preferredEffort = isReasoningEffort(model.defaultReasoningEffort) ? model.defaultReasoningEffort : defaultCodexReasoningEffort
    return [{
      id,
      displayName: model.displayName?.trim() || modelDisplayName(id),
      description: model.description?.trim() || undefined,
      enabled: model.enabled !== false,
      defaultReasoningEffort: efforts.includes(preferredEffort) ? preferredEffort : efforts[0],
      supportedReasoningEfforts: efforts,
    }]
  })

  if (!normalized.length) {
    const fallback = defaultModel.trim() || defaultCodexModelId
    return normalizeModelCatalog(
      fallback === defaultCodexModelId
        ? defaultCodexModelCatalog
        : [{ id: fallback, displayName: modelDisplayName(fallback), enabled: true }],
      fallback,
    )
  }

  const requestedDefault = defaultModel.trim()
  const defaultIndex = normalized.findIndex((model) => model.id === requestedDefault)
  if (defaultIndex >= 0) normalized[defaultIndex] = { ...normalized[defaultIndex], enabled: true }
  else if (!normalized.some((model) => model.enabled)) normalized[0] = { ...normalized[0], enabled: true }
  return normalized
}

export type ModelProviderConfig = {
  id: string
  name: string
  baseUrl: string
  maskedApiKey: string
  defaultModel: string
  models: ModelCatalogEntry[]
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

export type PluginInteractionMode = 'automatic' | 'requires_user_input'

export type PluginInputField = {
  id: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'image' | 'video' | 'audio' | 'file'
  helpText?: string
  maxFiles?: number
  placeholder?: string
  required?: boolean
  options?: Array<{ label: string; value: string }>
}

export type PluginInputUiConfig = {
  variant?: 'default' | 'video'
  kicker?: string
  title?: string
  description?: string
  promptSectionTitle?: string
  mediaSectionTitle?: string
  settingsSectionTitle?: string
}

export const interactiveVideoPluginInputUi = {
  variant: 'video',
  kicker: '视频生成',
  title: '确认视频需求',
  description: '写下想要的视频，也可以补充参考素材。',
  promptSectionTitle: '视频描述',
  mediaSectionTitle: '参考素材',
  settingsSectionTitle: '生成设置',
} satisfies PluginInputUiConfig

export const interactiveVideoPluginInputFields = [
  {
    id: 'prompt',
    label: '视频描述',
    type: 'textarea',
    required: true,
    placeholder: '描述想要的视频。可以写故事、广告脚本、镜头要求，也可以写“参考图片1的角色”。',
    helpText: '素材会按上传顺序交给视频模型，墨渊会整理成模型需要的内容结构。',
  },
  { id: 'firstFrame', label: '首帧图片', type: 'image', maxFiles: 1, helpText: '需要严格首帧一致时使用。' },
  { id: 'lastFrame', label: '尾帧图片', type: 'image', maxFiles: 1, helpText: '需要严格尾帧一致时使用。' },
  { id: 'referenceImages', label: '参考图片', type: 'image', maxFiles: 9, helpText: '0-9 张。建议角色图 1-2 张 + 场景/风格图 1 张，不要无意义堆满。' },
  { id: 'referenceVideos', label: '参考视频', type: 'video', maxFiles: 3, helpText: '0-3 个。可作为运镜、动作、特效或编辑/延长对象。' },
  { id: 'referenceAudios', label: '参考音频', type: 'audio', maxFiles: 3, helpText: '0-3 个。不要只传文本+音频；建议同时提供图片或视频素材。' },
  {
    id: 'ratio',
    label: '画面比例',
    type: 'select',
    options: videoRatioOptions.map((value) => ({ label: value, value })),
  },
  { id: 'duration', label: '视频时长', type: 'number' },
  { id: 'generateAudio', label: '生成音频', type: 'boolean' },
  { id: 'returnLastFrame', label: '保留尾帧', type: 'boolean', helpText: '生成后保留最后一帧，方便后续续写或做项目素材。' },
  { id: 'watermark', label: '添加水印', type: 'boolean' },
] satisfies PluginInputField[]

export const legacyInteractiveVideoPluginFieldIds = [
  'taskType',
  'subjectDefinitions',
  'shotList',
  'visualStyle',
  'constraints',
  'resolution',
  'referenceImage',
  'referenceVideo',
  'referenceImage1',
  'referenceImage2',
  'referenceVideo1',
  'referenceAudio1',
] as const

export function hasSeedanceInteractiveVideoPluginFields(fields: Pick<PluginInputField, 'id'>[] = []) {
  return fields.some((field) => field.id === 'prompt' || field.id === 'referenceImages' || field.id === 'generateAudio' || field.id === 'returnLastFrame')
}

export function hasLegacyInteractiveVideoPluginFields(fields: Pick<PluginInputField, 'id'>[] = []) {
  return fields.some((field) => legacyInteractiveVideoPluginFieldIds.includes(field.id as (typeof legacyInteractiveVideoPluginFieldIds)[number]))
}

export type PluginDefinition = {
  id: string
  name: string
  description: string
  category: 'media' | 'data' | 'workflow' | 'developer' | 'custom'
  handler: 'runtime' | 'server' | 'external'
  interactionMode: PluginInteractionMode
  targetTools?: string[]
  triggerPolicy?: 'manual' | 'before_tool'
  enabled: boolean
  ready: boolean
  status: 'ready' | 'needs_config' | 'disabled'
  triggerHints: string[]
  inputUi?: PluginInputUiConfig
  inputFields: PluginInputField[]
  permissions: string[]
  quotaType: 'token' | 'task' | 'asset'
  updatedAt?: string
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

export type BillingMeterType = 'brain' | 'image' | 'video'

export type BillingMeterConfig = {
  id: string
  type: BillingMeterType
  name: string
  provider?: string
  modelPattern?: string
  costCny: number
  costUnitTokens: number
  deductionFactor: number
  markupRate: number
  enabled: boolean
  updatedAt: string
}

export type BillingConfig = {
  platformPriceCny: number
  platformTokens: number
  meters: BillingMeterConfig[]
  updatedAt: string
}

export type UsageLedgerEntry = {
  id: string
  userEmail: string
  userId: string
  userName: string
  source: BillingMeterType
  provider?: string
  model?: string
  taskId?: string
  assetId?: string
  reportId?: string
  rawTokens: number
  billableProviderTokens: number
  deductionFactor: number
  platformTokens: number
  costCny: number
  billableCny: number
  markupRate: number
  platformTokenUnitPriceCny: number
  meterId: string
  meterName: string
  createdAt: string
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

export type UserWorkspaceSummary = {
  user: AccountUser
  assets: GeneratedAssetRecord[]
  usageLedger: UsageLedgerEntry[]
  totals: {
    assets: number
    images: number
    videos: number
    platformTokens: number
    rawTokens: number
    billableProviderTokens: number
    costCny: number
    billableCny: number
  }
}

export type EnterprisePolicy = {
  dataBoundary: 'local' | 'hybrid'
  auditEnabled: boolean
  externalSharing: 'blocked' | 'approval' | 'allowed'
  highRiskToolMode: 'auto' | 'approval' | 'blocked'
}

export type Employee = {
  id: string
  name: string
  department: string
  title: string
  source: OrgSource
  manager: string
}

export type RuntimeTurnStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'interrupted'

export type RuntimeTaskItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'declined'

export type RuntimeTaskItemType =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'command'
  | 'file_change'
  | 'tool_call'
  | 'web_search'
  | 'image_generation'
  | 'video_generation'
  | 'plugin'
  | 'approval'
  | 'system'

export type RuntimePlanStep = {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type RuntimeTaskItem = {
  id: string
  type: RuntimeTaskItemType
  title: string
  status: RuntimeTaskItemStatus
  turnId?: string
  content?: string
  summary?: string
  metadata?: Record<string, unknown>
  startedAt?: string
  completedAt?: string
}

export type RuntimeTaskOutput = {
  id: string
  type: 'file' | 'asset' | 'link' | 'image' | 'video' | 'plugin_result'
  title: string
  turnId?: string
  url?: string
  path?: string
  mediaType?: string
  taskItemId?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export type RuntimeTaskSource = {
  id: string
  type: 'web' | 'file' | 'plugin' | 'skill' | 'tool' | 'knowledge'
  title: string
  url?: string
  path?: string
  query?: string
  taskItemId?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

export type RuntimeApprovalRequest = {
  id: string
  type: 'command' | 'file_change' | 'permissions' | 'plugin' | 'tool'
  status: 'pending' | 'approved' | 'declined' | 'cancelled'
  title: string
  reason?: string
  turnId?: string
  itemId?: string
  metadata?: Record<string, unknown>
  createdAt: string
  resolvedAt?: string
}

export type RuntimePluginInputRequest = {
  id: string
  pluginId: string
  title: string
  status: 'pending' | 'submitted' | 'cancelled'
  turnId?: string
  itemId?: string
  fields: PluginInputField[]
  inputUi?: PluginInputUiConfig
  values?: Record<string, unknown>
  createdAt: string
  resolvedAt?: string
}

export type RuntimeTurn = {
  id: string
  status: RuntimeTurnStatus
  plan?: RuntimePlanStep[]
  startedAt?: string
  completedAt?: string
  error?: string
}

export type CodexTask = {
  id: string
  title: string
  status: 'queued' | 'running' | 'needs_approval' | 'completed' | 'failed' | 'interrupted'
  workspace: string
  model?: string
  reasoningEffort?: ReasoningEffort
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
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
  approvals?: RuntimeApprovalRequest[]
  items?: RuntimeTaskItem[]
  outputs?: RuntimeTaskOutput[]
  plan?: RuntimePlanStep[]
  pluginRequests?: RuntimePluginInputRequest[]
  sources?: RuntimeTaskSource[]
  turns?: RuntimeTurn[]
  transcript: Array<{
    role: 'user' | 'assistant' | 'tool' | 'system'
    content: string
    attachments?: RuntimeAttachment[]
    timestamp: string
    eventId?: string
    itemId?: string
    seq?: number
    turnId?: string
  }>
}

export type RuntimeAttachment = {
  id: string
  type: 'image'
  name: string
  mimeType: string
  size: number
  localUrl?: string
  dataUrl?: string
  storageUrl?: string
  fileId?: string
  sha256?: string
  createdAt: string
}

export type ImageGenerationInputImage = {
  file_id?: string
  image_url?: string | { url: string }
  url?: string
  dataUrl?: string
  mimeType?: string
  name?: string
  sha256?: string
  size?: number
}

export type ImageGenerationResult = {
  id: string
  prompt: string
  model: string
  size: string
  url: string
  usageTokens?: number
  rawTokens?: number
  billableProviderTokens?: number
  deductionFactor?: number
  costCny?: number
  billableCny?: number
  createdAt: string
}

export type VideoGenerationResult = {
  id: string
  prompt: string
  model: string
  url: string
  lastFrameUrl?: string
  returnLastFrame?: boolean
  duration?: number
  ratio?: string
  resolution?: string
  usageTokens?: number
  rawTokens?: number
  billableProviderTokens?: number
  deductionFactor?: number
  costCny?: number
  billableCny?: number
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
  rawTokens?: number
  billableProviderTokens?: number
  deductionFactor?: number
  costCny?: number
  billableCny?: number
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
  type:
    | 'thread.started'
    | 'turn.started'
    | 'turn.completed'
    | 'turn.failed'
    | 'turn.interrupted'
    | 'plan.updated'
    | 'item.started'
    | 'item.delta'
    | 'item.completed'
    | 'approval.requested'
    | 'approval.resolved'
    | 'plugin.inputRequested'
    | 'plugin.inputSubmitted'
    | 'output.added'
    | 'message'
    | 'message_delta'
    | 'tool'
    | 'error'
    | 'process.exit'
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  timestamp: string
  seq?: number
  itemId?: string
  turnId?: string
  approval?: RuntimeApprovalRequest
  item?: RuntimeTaskItem
  output?: RuntimeTaskOutput
  plan?: RuntimePlanStep[]
  pluginRequest?: RuntimePluginInputRequest
  source?: RuntimeTaskSource
  attachments?: RuntimeAttachment[]
  raw?: unknown
}

export {
  applyTaskStructureEvent,
  compactAssistantTranscript,
  finalAssistantContent,
  friendlyRuntimeMessage,
  isRuntimeFailureNotice,
  mergeAssistantContent,
  runtimeFailureDiagnostic,
  runtimeTaskStatusExplanation,
  type CodexTranscriptItem,
  type RuntimeTaskStatusExplanation,
  type StructuredTaskEvent,
} from './task-normalization.js'
