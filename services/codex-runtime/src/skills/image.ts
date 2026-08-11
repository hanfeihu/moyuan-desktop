import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ImageGenerationInputImage, RuntimeAttachment } from '@eaw/shared'
import { defaultEnterpriseApiBase } from '../config.js'
import { enterpriseJson } from '../enterprise/client.js'
import type { EnterpriseSkillSet, RuntimeRunOptions } from './contracts.js'

export type ImageSize = '1024x1024' | '1024x1536' | '1536x1024'

type GenerateImageOptions = {
  images?: ImageGenerationInputImage[]
  model?: string
  options: RuntimeRunOptions
  prompt: string
  runtimeRoot: string
  size: string
  skills: EnterpriseSkillSet
}

type ImageGenerationDiagnostic = {
  message?: string
  requestId?: string
  stage?: string
  status?: number
  upstreamDurationMs?: number
  upstreamErrorCode?: string
}

export function inferImageSize(prompt: string): ImageSize {
  return '1024x1024'
}

export function buildImagePrompt(prompt: string) {
  return prompt.trim()
}

function firstImageFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const raw = (payload as { raw?: unknown }).raw
  const source = raw && typeof raw === 'object' ? raw : payload
  const data = (source as { data?: unknown }).data
  return Array.isArray(data) && data[0] && typeof data[0] === 'object' ? (data[0] as { b64_json?: string; url?: string }) : undefined
}

function usageTokensFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const usageTokens = (payload as { usageTokens?: unknown }).usageTokens
  return typeof usageTokens === 'number' ? usageTokens : undefined
}

function numberFromPayload(payload: unknown, key: string) {
  if (!payload || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function storageUrlFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const storageUrl = (payload as { storageUrl?: unknown }).storageUrl
  return typeof storageUrl === 'string' && storageUrl ? storageUrl : undefined
}

function imageJobIdFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const jobId = (payload as { jobId?: unknown }).jobId
  return typeof jobId === 'string' && jobId ? jobId : undefined
}

function imageJobStatus(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const status = (payload as { status?: unknown }).status
  return typeof status === 'string' ? status : undefined
}

function imageDiagnosticFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') return undefined
  const diagnostic = (payload as { diagnostic?: unknown }).diagnostic
  return diagnostic && typeof diagnostic === 'object' ? (diagnostic as ImageGenerationDiagnostic) : undefined
}

export function toFriendlyImageError(message: string, diagnostic?: ImageGenerationDiagnostic) {
  const normalizedMessage = message.replace(/%!s\(int64=(\d+)\)/g, '$1').trim()
  const requestId = diagnostic?.requestId ?? normalizedMessage.match(/(?:请求\s*ID|Request\s*id)\s*[:：]\s*([A-Za-z0-9_.:-]+)/i)?.[1]?.replace(/[.。,:：;；]+$/, '')
  const suffix = requestId ? ` 排障请求 ID：${requestId}` : ''
  const duration = typeof diagnostic?.upstreamDurationMs === 'number' ? `，上游耗时约 ${Math.round(diagnostic.upstreamDurationMs / 1000)} 秒` : ''
  if (diagnostic?.status === 504 || /504|Gateway Timeout|timeout|timed out|超时/i.test(normalizedMessage)) {
    return `图片模型通道超时${duration}。这通常是图片服务排队、网关超时或通道短暂波动，不是你的提示词一定有问题。${suffix}`
  }
  if (diagnostic?.status === 401 || diagnostic?.status === 403 || /invalid api key|unauthorized|forbidden|401|403/i.test(normalizedMessage)) {
    return `图片模型通道鉴权失败。后台图片技能的 KEY、Base URL 或默认模型可能不匹配，需要管理员检查配置。${suffix}`
  }
  if (/没有返回 usage\.total_tokens|无法计费/i.test(normalizedMessage)) {
    return `图片已经请求到上游，但返回里缺少计费用量，系统为了避免乱扣费没有入账。需要检查图片代理的返回格式。${suffix}`
  }
  if (diagnostic?.status && diagnostic.status >= 500) {
    return `图片模型通道暂时不可用，上游返回 ${diagnostic.status}${duration}。可以稍后重试。${suffix}`
  }
  return `${normalizedMessage}${suffix}`
}

export function buildImageFailureAssistantMessage(message: string, diagnostic?: ImageGenerationDiagnostic) {
  const friendly = toFriendlyImageError(message, diagnostic)
  if (/图片模型通道超时|Gateway Timeout|504|超时/i.test(friendly)) {
    return `这次图片没有生成出来。原因是：图片模型通道超时，服务端没有在预期时间内拿到上游结果。\n\n这更像通道排队或网关波动，不是你这个需求不能做。可以直接重新发送，或者把画面描述稍微收窄一点再试。`
  }
  if (/鉴权失败|KEY|Base URL|默认模型/i.test(friendly)) {
    return `这次图片没有生成出来。原因是：图片模型通道配置可能不匹配。\n\n需要管理员检查后台图片技能的 KEY、Base URL 和默认模型。`
  }
  if (/无法计费|usage\.total_tokens|计费用量/i.test(friendly)) {
    return `这次图片请求没有完成入账。上游返回里缺少计费用量，系统为了避免扣错 Token 没有把它当成成品。\n\n需要检查图片代理返回格式后再试。`
  }
  return `这次图片没有生成出来。原因是：${friendly}\n\n可以调整提示词后重新发送，我会继续接着处理。`
}

export function imageInputsFromAttachments(attachments: RuntimeAttachment[] = []): ImageGenerationInputImage[] {
  const images: ImageGenerationInputImage[] = []
  for (const attachment of attachments) {
    if (attachment.type !== 'image') continue
    const url = attachment.storageUrl ?? attachment.dataUrl
    if (url) {
      images.push({ image_url: { url }, mimeType: attachment.mimeType, name: attachment.name, sha256: attachment.sha256, size: attachment.size })
    } else if (attachment.fileId) {
      images.push({ file_id: attachment.fileId, mimeType: attachment.mimeType, name: attachment.name, sha256: attachment.sha256, size: attachment.size })
    }
    if (images.length >= 16) break
  }
  return images
}

async function waitForImageJob(jobId: string, authToken: string, baseUrl: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5 * 60 * 1000) {
    const payload = await enterpriseJson(`/skills/image/generations/${encodeURIComponent(jobId)}`, authToken, baseUrl, { timeoutMs: 20000 })
    const status = imageJobStatus(payload)
    if (status === 'succeeded') return payload
    if (status === 'failed') {
      const error = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined
      const diagnostic = imageDiagnosticFromPayload(payload)
      const message = typeof error === 'string' && error ? error : '图片生成失败'
      const failed = new Error(toFriendlyImageError(message, diagnostic)) as Error & { diagnostic?: ImageGenerationDiagnostic }
      failed.diagnostic = diagnostic
      throw failed
    }
    await sleep(2200)
  }
  throw new Error('图片生成仍在处理中，请稍后重试或在后台资源记录查看结果')
}

export async function generateImage({ images = [], prompt, runtimeRoot, size, model, options, skills }: GenerateImageOptions) {
  const authToken = options.enterpriseAuthToken
  const baseUrl = options.enterpriseApiBase ?? defaultEnterpriseApiBase
  const imageSkill = skills.imageGeneration
  if (!authToken) throw new Error('请先登录墨渊账号')
  if (!imageSkill.enabled || !imageSkill.apiKeyConfigured) throw new Error('图片生成技能未启用，请管理员在后台配置 gpt-image-2 KEY')
  const imagePrompt = buildImagePrompt(prompt)

  const createdPayload = await enterpriseJson('/skills/image/generations', authToken, baseUrl, {
    body: JSON.stringify({
      async: true,
      model: model ?? imageSkill.defaultModel,
      n: 1,
      prompt: imagePrompt,
      size,
      ...(images.length ? { images } : {}),
    }),
    method: 'POST',
    timeoutMs: 30000,
  })
  const payload = imageJobIdFromPayload(createdPayload) ? await waitForImageJob(imageJobIdFromPayload(createdPayload)!, authToken, baseUrl) : createdPayload
  const id = randomUUID()
  const storageUrl = storageUrlFromPayload(payload)
  const usageTokens = usageTokensFromPayload(payload)
  const rawTokens = numberFromPayload(payload, 'rawTokens')
  const billableProviderTokens = numberFromPayload(payload, 'billableProviderTokens')
  const deductionFactor = numberFromPayload(payload, 'deductionFactor')
  const costCny = numberFromPayload(payload, 'costCny')
  const billableCny = numberFromPayload(payload, 'billableCny')
  if (storageUrl) {
    return {
      id,
      prompt,
      model: model ?? imageSkill.defaultModel,
      size,
      url: storageUrl,
      usageTokens,
      rawTokens,
      billableProviderTokens,
      deductionFactor,
      costCny,
      billableCny,
      createdAt: new Date().toISOString(),
    }
  }
  const firstImage = firstImageFromPayload(payload)
  const b64Json = firstImage?.b64_json
  if (firstImage?.url && !b64Json) {
    return {
      id,
      prompt,
      model: model ?? imageSkill.defaultModel,
      size,
      url: firstImage.url,
      usageTokens,
      rawTokens,
      billableProviderTokens,
      deductionFactor,
      costCny,
      billableCny,
      createdAt: new Date().toISOString(),
    }
  }

  if (!b64Json) {
    throw new Error('图片生成接口没有返回可用图片数据')
  }

  const fileName = `${id}.png`
  const imageDir = path.join(runtimeRoot, 'images')
  await mkdir(imageDir, { recursive: true })
  await writeFile(path.join(imageDir, fileName), Buffer.from(b64Json, 'base64'))

  return {
    id,
    prompt,
    model: model ?? imageSkill.defaultModel,
    size,
    url: `/api/images/${fileName}`,
    usageTokens,
    rawTokens,
    billableProviderTokens,
    deductionFactor,
    costCny,
    billableCny,
    createdAt: new Date().toISOString(),
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
