import type { VideoGenerationResult } from '@eaw/shared'
import { defaultEnterpriseApiBase } from '../config.js'
import { enterpriseJson } from '../enterprise/client.js'
import { defaultVideoRatioForModel, type EnterpriseSkillSet, type MoyuanToolCall, type RuntimeRunOptions } from './contracts.js'

type VideoToolCall = Extract<MoyuanToolCall, { tool: 'video_generation' }>

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

function toFriendlyVideoError(message: string) {
  const requestId = message.match(/请求\s*ID[:：]\s*([A-Za-z0-9_-]+)/i)?.[1]
  const requestSuffix = requestId ? ` 排障请求 ID：${requestId}` : ''
  if (/敏感信息|敏感内容|sensitive|safety|安全审核|content policy|policy violation/i.test(message)) {
    return `视频没有生成成功。视频服务的安全审核拦截了这次请求，通常是提示词里包含公众人物、敏感关系、暴力、政治或容易引发误解的描述。可以换成更中性的虚构角色或卡通表达后重试。${requestSuffix}`
  }
  if (/not activated the model|has not activated the model|activate the model service/i.test(message)) {
    return '火山方舟视频模型还没有开通，请管理员到 Ark 控制台开通当前视频模型后再试。'
  }
  return message.replace(/%!s\(int64=(\d+)\)/g, '$1')
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
  onStatus: (content: string) => void,
): Promise<VideoGenerationResult> {
  const authToken = options.enterpriseAuthToken
  const baseUrl = options.enterpriseApiBase ?? defaultEnterpriseApiBase
  const video = skills.videoGeneration
  if (!authToken) throw new Error('请先登录墨渊账号')
  if (!video?.enabled || !video.apiKeyConfigured) throw new Error('视频生成技能未启用，请管理员在后台配置火山方舟 KEY')

  onStatus('正在调用视频生成技能...')
  const created = (await enterpriseJson('/skills/video/generations', authToken, baseUrl, {
    body: JSON.stringify(buildVideoRequest(toolCall, prompt, skills)),
    method: 'POST',
  })) as { raw?: unknown; status?: string; taskId?: string; usageTokens?: number; videoUrl?: string }

  const taskId = created.taskId ?? findFirstString(created.raw, ['id', 'task_id', 'taskId'])
  const createError = findVideoErrorMessage(created.raw)
  if (createError && normalizedVideoStatus(created.status ?? findFirstString(created.raw, ['status'])) !== 'completed') {
    throw new Error(toFriendlyVideoError(createError))
  }
  if (!taskId) throw new Error('视频生成任务没有返回任务 ID')

  onStatus('视频任务已创建，正在生成...')
  let lastStatus = created.status ?? findFirstString(created.raw, ['status'])
  let usageTokens = created.usageTokens
  let videoUrl = created.videoUrl ?? findFirstVideoUrl(created.raw)
  const deadline = Date.now() + Number(process.env.VIDEO_TIMEOUT_MS ?? 900000)

  while (!videoUrl && normalizedVideoStatus(lastStatus) === 'running' && Date.now() < deadline) {
    await sleep(Number(process.env.VIDEO_POLL_INTERVAL_MS ?? 6000))
    const queried = (await enterpriseJson(`/skills/video/generations/${encodeURIComponent(taskId)}`, authToken, baseUrl)) as {
      chargeStatus?: string
      raw?: unknown
      status?: string
      usageTokens?: number
      videoUrl?: string
    }
    lastStatus = queried.status ?? findFirstString(queried.raw, ['status'])
    usageTokens = queried.usageTokens ?? usageTokens
    videoUrl = queried.videoUrl ?? findFirstVideoUrl(queried.raw)
    const statusLabel = lastStatus ? `当前状态：${lastStatus}` : '视频仍在生成中'
    onStatus(statusLabel)
    const errorMessage = findVideoErrorMessage(queried.raw)
    if (errorMessage) throw new Error(toFriendlyVideoError(errorMessage))
    if (normalizedVideoStatus(lastStatus) === 'failed') {
      const message = findFirstString(queried.raw, ['message', 'error', 'msg']) ?? '视频生成失败'
      throw new Error(toFriendlyVideoError(message))
    }
  }

  if (!videoUrl) throw new Error('视频生成超时，请稍后在历史会话里重试或缩短视频描述')

  return {
    id: taskId,
    prompt,
    model: toolCall.model ?? video.defaultModel,
    url: videoUrl,
    duration: toolCall.duration ?? video.defaultDuration,
    ratio: toolCall.ratio ?? video.defaultRatio,
    resolution: video.defaultResolution,
    usageTokens,
    createdAt: new Date().toISOString(),
  }
}
