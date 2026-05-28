import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defaultEnterpriseApiBase } from '../config.js'
import { enterpriseJson } from '../enterprise/client.js'
import type { EnterpriseSkillSet, RuntimeRunOptions } from './contracts.js'

export type ImageSize = '1024x1024' | '1024x1536' | '1536x1024'

type GenerateImageOptions = {
  model?: string
  options: RuntimeRunOptions
  prompt: string
  runtimeRoot: string
  size: string
  skills: EnterpriseSkillSet
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

async function waitForImageJob(jobId: string, authToken: string, baseUrl: string) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5 * 60 * 1000) {
    const payload = await enterpriseJson(`/skills/image/generations/${encodeURIComponent(jobId)}`, authToken, baseUrl, { timeoutMs: 20000 })
    const status = imageJobStatus(payload)
    if (status === 'succeeded') return payload
    if (status === 'failed') {
      const error = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined
      throw new Error(typeof error === 'string' && error ? error : '图片生成失败')
    }
    await sleep(2200)
  }
  throw new Error('图片生成仍在处理中，请稍后重试或在后台资源记录查看结果')
}

export async function generateImage({ prompt, runtimeRoot, size, model, options, skills }: GenerateImageOptions) {
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
    }),
    method: 'POST',
    timeoutMs: 30000,
  })
  const payload = imageJobIdFromPayload(createdPayload) ? await waitForImageJob(imageJobIdFromPayload(createdPayload)!, authToken, baseUrl) : createdPayload
  const id = randomUUID()
  const storageUrl = storageUrlFromPayload(payload)
  const usageTokens = usageTokensFromPayload(payload)
  if (storageUrl) {
    return {
      id,
      prompt,
      model: model ?? imageSkill.defaultModel,
      size,
      url: storageUrl,
      usageTokens,
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
    createdAt: new Date().toISOString(),
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
