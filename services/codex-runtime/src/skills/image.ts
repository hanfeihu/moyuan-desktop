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

export async function generateImage({ prompt, runtimeRoot, size, model, options, skills }: GenerateImageOptions) {
  const authToken = options.enterpriseAuthToken
  const imageSkill = skills.imageGeneration
  if (!authToken) throw new Error('请先登录墨渊账号')
  if (!imageSkill.enabled || !imageSkill.apiKeyConfigured) throw new Error('图片生成技能未启用，请管理员在后台配置 gpt-image-2 KEY')
  const imagePrompt = buildImagePrompt(prompt)

  const payload = await enterpriseJson('/skills/image/generations', authToken, options.enterpriseApiBase ?? defaultEnterpriseApiBase, {
    body: JSON.stringify({
      model: model ?? imageSkill.defaultModel,
      n: 1,
      prompt: imagePrompt,
      size,
    }),
    method: 'POST',
  })
  const id = randomUUID()
  const firstImage = firstImageFromPayload(payload)
  const b64Json = firstImage?.b64_json
  const usageTokens = usageTokensFromPayload(payload)
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
