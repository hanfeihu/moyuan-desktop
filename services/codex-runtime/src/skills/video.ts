import type { VideoGenerationResult } from '@eaw/shared'
import { defaultEnterpriseApiBase } from '../config.js'
import { enterpriseJson } from '../enterprise/client.js'
import { defaultVideoRatioForModel, type EnterpriseSkillSet, type MoyuanToolCall, type RuntimeRunOptions } from './contracts.js'

type VideoToolCall = Extract<MoyuanToolCall, { tool: 'video_generation' }>

export type VideoStatusUpdate = {
  content: string
  raw?: unknown
  status?: string
  taskId?: string
  lastFrameUrl?: string
  usageTokens?: number
  videoUrl?: string
}

export function findFirstString(payload: unknown, keys: string[]): string | undefined {
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

export function findFirstVideoUrl(payload: unknown): string | undefined {
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

function isImageUrl(value: string) {
  return /^https?:\/\//i.test(value) && /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(value)
}

export function findFirstLastFrameUrl(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findFirstLastFrameUrl(item)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replace(/[-_\s]+/g, '')
    const looksLikeLastFrame = normalizedKey.includes('lastframe') || normalizedKey.includes('tailframe') || normalizedKey.includes('endframe')
    if (typeof value === 'string' && looksLikeLastFrame && isImageUrl(value)) return value
    if (looksLikeLastFrame && value && typeof value === 'object') {
      const nested = findFirstString(value, ['url', 'image_url', 'imageUrl'])
      if (nested && isImageUrl(nested)) return nested
    }
  }
  for (const value of Object.values(record)) {
    const found = findFirstLastFrameUrl(value)
    if (found) return found
  }
  return undefined
}

export function normalizedVideoStatus(status?: string) {
  const value = (status ?? '').toLowerCase()
  if (['succeeded', 'success', 'completed', 'done', 'finish', 'finished'].some((item) => value.includes(item))) return 'completed'
  if (['failed', 'error', 'canceled', 'cancelled', 'rejected'].some((item) => value.includes(item))) return 'failed'
  return 'running'
}

function findVideoErrorMessage(payload: unknown): string | undefined {
  const message = findFirstString(payload, ['error', 'error_message', 'errorMessage', 'message', 'msg'])
  if (!message) return undefined
  if (/success|succeeded|running|queued|pending|processing|created/i.test(message)) return undefined
  return message
}

export function toFriendlyVideoError(message: string) {
  const normalizedMessage = message.replace(/%!s\(int64=(\d+)\)/g, '$1').trim()
  const requestId = normalizedMessage.match(/(?:请求\s*ID|Request\s*id)\s*[:：]\s*([A-Za-z0-9_.:-]+)/i)?.[1]?.replace(/[.。,:：;；]+$/, '')
  const requestSuffix = requestId ? ` 排障请求 ID：${requestId}` : ''
  if (/input\s+image.*may\s+contain\s+real\s+person|may\s+contain\s+real\s+person|参考图片.*真人/i.test(normalizedMessage)) {
    return `视频没有生成成功。参考图片可能包含真人，视频服务拒绝了这次请求。建议改用非真人、卡通或 3D 风格素材，或者先把参考图转成原创角色后再生成。${requestSuffix}`
  }
  if (/copyright\s+restrictions?|copyright|版权|IP\s*相似/i.test(normalizedMessage)) {
    return `视频没有生成成功。生成结果可能触发版权或 IP 相似风险，视频服务拦截了这次请求。建议避开明星脸、影视剧/动漫 IP、品牌 Logo 或已有作品风格，改成原创角色和原创场景后重试。${requestSuffix}`
  }
  if (/敏感信息|敏感内容|sensitive|safety|安全审核|content policy|policy violation/i.test(normalizedMessage)) {
    return `视频没有生成成功。视频服务的安全审核拦截了这次请求，通常是提示词里包含公众人物、敏感关系、暴力、政治或容易引发误解的描述。可以换成更中性的虚构角色或卡通表达后重试。${requestSuffix}`
  }
  if (/not activated the model|has not activated the model|activate the model service/i.test(normalizedMessage)) {
    return '火山方舟视频模型还没有开通，请管理员到 Ark 控制台开通当前视频模型后再试。'
  }
  return normalizedMessage
}

export function buildVideoFailureAssistantMessage(message: string) {
  const friendly = toFriendlyVideoError(message)
  if (/参考图片可能包含真人|may\s+contain\s+real\s+person/i.test(friendly)) {
    return `这次视频没有生成成功。原因是：参考图片可能包含真人，视频服务拒绝了这次请求。\n\n可以这样改：换成非真人、卡通或 3D 风格素材，或者先把参考图改成原创角色后再生成视频。`
  }
  if (/版权|IP\s*相似|copyright/i.test(friendly)) {
    return `这次视频没有生成成功。原因是：生成结果可能触发版权或 IP 相似风险，视频服务拦截了这次请求。\n\n可以这样改：避开明星脸、影视剧/动漫 IP、品牌 Logo 或已有作品风格，改成原创角色、原创场景和更明确的画面描述后重试。`
  }
  if (/安全审核|safety|content policy|policy violation/i.test(friendly)) {
    return `这次视频没有生成成功。原因是：视频服务的安全审核拦截了这次请求。\n\n可以这样改：把公众人物、敏感关系、暴力或容易误解的描述换成更中性的虚构角色或卡通表达。`
  }
  if (/视频模型还没有开通|not activated the model|activate the model service/i.test(friendly)) {
    return `这次视频没有生成成功。原因是：火山方舟当前视频模型还没有开通。\n\n需要管理员到 Ark 控制台开通这个模型后再试。`
  }
  return `这次视频没有生成成功。原因是：${friendly}\n\n可以调整提示词或素材后重新发送，我会继续接着处理。`
}

export function buildVideoRequest(toolCall: VideoToolCall, prompt: string, skills: EnterpriseSkillSet) {
  const video = skills.videoGeneration
  const model = toolCall.model ?? video?.defaultModel
  return {
    content: toolCall.content?.length ? toolCall.content : [{ type: 'text', text: toolCall.prompt ?? prompt }],
    duration: toolCall.duration ?? video?.defaultDuration ?? 8,
    generate_audio: toolCall.generateAudio ?? true,
    model,
    prompt: toolCall.prompt ?? prompt,
    ratio: toolCall.ratio ?? video?.defaultRatio ?? defaultVideoRatioForModel(model),
    return_last_frame: toolCall.returnLastFrame ?? true,
    watermark: toolCall.watermark ?? false,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function generateVideo(
  prompt: string,
  toolCall: VideoToolCall,
  options: RuntimeRunOptions,
  skills: EnterpriseSkillSet,
  onStatus: (update: VideoStatusUpdate) => void,
): Promise<VideoGenerationResult> {
  const authToken = options.enterpriseAuthToken
  const baseUrl = options.enterpriseApiBase ?? defaultEnterpriseApiBase
  const video = skills.videoGeneration
  if (!authToken) throw new Error('请先登录墨渊账号')
  if (!video?.enabled || !video.apiKeyConfigured) throw new Error('视频生成技能未启用，请管理员在后台配置火山方舟 KEY')

  onStatus({ content: '正在调用视频生成技能...' })
  const created = (await enterpriseJson('/skills/video/generations', authToken, baseUrl, {
    body: JSON.stringify(buildVideoRequest(toolCall, prompt, skills)),
    method: 'POST',
  })) as { billableCny?: number; billableProviderTokens?: number; costCny?: number; deductionFactor?: number; lastFrameUrl?: string; raw?: unknown; rawTokens?: number; status?: string; taskId?: string; usageTokens?: number; videoUrl?: string }

  const taskId = created.taskId ?? findFirstString(created.raw, ['id', 'task_id', 'taskId'])
  const createError = findVideoErrorMessage(created.raw)
  if (createError && normalizedVideoStatus(created.status ?? findFirstString(created.raw, ['status'])) !== 'completed') {
    throw new Error(toFriendlyVideoError(createError))
  }
  if (!taskId) throw new Error('视频生成任务没有返回任务 ID')

  let lastStatus = created.status ?? findFirstString(created.raw, ['status'])
  let usageTokens = created.usageTokens
  let rawTokens = created.rawTokens
  let billableProviderTokens = created.billableProviderTokens
  let deductionFactor = created.deductionFactor
  let costCny = created.costCny
  let billableCny = created.billableCny
  let videoUrl = created.videoUrl ?? findFirstVideoUrl(created.raw)
  let lastFrameUrl = created.lastFrameUrl ?? findFirstLastFrameUrl(created.raw)
  onStatus({ content: '视频任务已创建，正在生成...', lastFrameUrl, raw: created.raw, status: lastStatus, taskId, usageTokens, videoUrl })
  const deadline = Date.now() + Number(process.env.VIDEO_TIMEOUT_MS ?? 900000)

  while (!videoUrl && normalizedVideoStatus(lastStatus) === 'running' && Date.now() < deadline) {
    await sleep(Number(process.env.VIDEO_POLL_INTERVAL_MS ?? 6000))
    const queried = (await enterpriseJson(`/skills/video/generations/${encodeURIComponent(taskId)}`, authToken, baseUrl)) as {
      billableCny?: number
      billableProviderTokens?: number
      chargeStatus?: string
      costCny?: number
      deductionFactor?: number
      lastFrameUrl?: string
      raw?: unknown
      rawTokens?: number
      status?: string
      usageTokens?: number
      videoUrl?: string
    }
    lastStatus = queried.status ?? findFirstString(queried.raw, ['status'])
    usageTokens = queried.usageTokens ?? usageTokens
    rawTokens = queried.rawTokens ?? rawTokens
    billableProviderTokens = queried.billableProviderTokens ?? billableProviderTokens
    deductionFactor = queried.deductionFactor ?? deductionFactor
    costCny = queried.costCny ?? costCny
    billableCny = queried.billableCny ?? billableCny
    videoUrl = queried.videoUrl ?? findFirstVideoUrl(queried.raw)
    lastFrameUrl = queried.lastFrameUrl ?? findFirstLastFrameUrl(queried.raw) ?? lastFrameUrl
    const statusLabel = lastStatus ? `当前状态：${lastStatus}` : '视频仍在生成中'
    onStatus({ content: statusLabel, lastFrameUrl, raw: queried.raw, status: lastStatus, taskId, usageTokens, videoUrl })
    const errorMessage = findVideoErrorMessage(queried.raw)
    if (errorMessage) throw new Error(toFriendlyVideoError(errorMessage))
    if (normalizedVideoStatus(lastStatus) === 'failed') {
      const message = findFirstString(queried.raw, ['message', 'error', 'msg']) ?? '视频生成失败'
      throw new Error(toFriendlyVideoError(message))
    }
  }

  if (!videoUrl) throw new Error('视频生成超时，请稍后在历史会话里重试或缩短视频描述')
  if ((toolCall.returnLastFrame ?? true) && !lastFrameUrl) {
    try {
      const queried = (await enterpriseJson(`/skills/video/generations/${encodeURIComponent(taskId)}`, authToken, baseUrl)) as {
        billableCny?: number
        billableProviderTokens?: number
        costCny?: number
        deductionFactor?: number
        lastFrameUrl?: string
        raw?: unknown
        rawTokens?: number
        usageTokens?: number
        videoUrl?: string
      }
      usageTokens = queried.usageTokens ?? usageTokens
      rawTokens = queried.rawTokens ?? rawTokens
      billableProviderTokens = queried.billableProviderTokens ?? billableProviderTokens
      deductionFactor = queried.deductionFactor ?? deductionFactor
      costCny = queried.costCny ?? costCny
      billableCny = queried.billableCny ?? billableCny
      videoUrl = queried.videoUrl ?? findFirstVideoUrl(queried.raw) ?? videoUrl
      lastFrameUrl = queried.lastFrameUrl ?? findFirstLastFrameUrl(queried.raw) ?? lastFrameUrl
    } catch {
      // Video generation succeeded; missing tail-frame metadata should not hide the main video resource.
    }
  }

  return {
    id: taskId,
    prompt,
    model: toolCall.model ?? video.defaultModel,
    url: videoUrl,
    lastFrameUrl,
    returnLastFrame: toolCall.returnLastFrame ?? true,
    duration: toolCall.duration ?? video.defaultDuration,
    ratio: toolCall.ratio ?? video.defaultRatio,
    resolution: video.defaultResolution,
    usageTokens,
    rawTokens,
    billableProviderTokens,
    deductionFactor,
    costCny,
    billableCny,
    createdAt: new Date().toISOString(),
  }
}

export async function queryVideoGeneration(
  taskId: string,
  options: RuntimeRunOptions,
  defaults: {
    createdAt?: string
    duration?: number
    model?: string
    prompt: string
    ratio?: string
    returnLastFrame?: boolean
    resolution?: string
  },
) {
  const authToken = options.enterpriseAuthToken
  const baseUrl = options.enterpriseApiBase ?? defaultEnterpriseApiBase
  if (!authToken) throw new Error('请先登录墨渊账号')

  const queried = (await enterpriseJson(`/skills/video/generations/${encodeURIComponent(taskId)}`, authToken, baseUrl)) as {
    billableCny?: number
    billableProviderTokens?: number
    chargeStatus?: string
    costCny?: number
    deductionFactor?: number
    lastFrameUrl?: string
    raw?: unknown
    rawTokens?: number
    status?: string
    usageTokens?: number
    videoUrl?: string
  }
  const status = queried.status ?? findFirstString(queried.raw, ['status'])
  const videoUrl = queried.videoUrl ?? findFirstVideoUrl(queried.raw)
  const lastFrameUrl = queried.lastFrameUrl ?? findFirstLastFrameUrl(queried.raw)
  const errorMessage = findVideoErrorMessage(queried.raw)
  if (errorMessage) {
    return {
      error: toFriendlyVideoError(errorMessage),
      raw: queried.raw,
      status: 'failed',
      taskId,
    }
  }

  if (normalizedVideoStatus(status) === 'failed') {
    const message = findFirstString(queried.raw, ['message', 'error', 'msg']) ?? '视频生成失败'
    return {
      error: toFriendlyVideoError(message),
      raw: queried.raw,
      status: 'failed',
      taskId,
    }
  }

  if (!videoUrl) {
    return {
      raw: queried.raw,
      status: status ?? 'running',
      taskId,
      usageTokens: queried.usageTokens,
      rawTokens: queried.rawTokens,
      billableProviderTokens: queried.billableProviderTokens,
      deductionFactor: queried.deductionFactor,
      costCny: queried.costCny,
      billableCny: queried.billableCny,
    }
  }

  return {
    raw: queried.raw,
    status: 'completed',
    taskId,
    usageTokens: queried.usageTokens,
    video: {
      id: taskId,
      prompt: defaults.prompt,
      model: defaults.model ?? findFirstString(queried.raw, ['model']) ?? 'video',
      url: videoUrl,
      lastFrameUrl,
      returnLastFrame: defaults.returnLastFrame,
      duration: defaults.duration,
      ratio: defaults.ratio,
      resolution: defaults.resolution,
      usageTokens: queried.usageTokens,
      rawTokens: queried.rawTokens,
      billableProviderTokens: queried.billableProviderTokens,
      deductionFactor: queried.deductionFactor,
      costCny: queried.costCny,
      billableCny: queried.billableCny,
      createdAt: defaults.createdAt ?? new Date().toISOString(),
    } satisfies VideoGenerationResult,
  }
}
