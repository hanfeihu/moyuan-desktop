import type { AccountUser, RuntimeAttachment } from '@eaw/shared'
import { enterpriseFetch, runtimeFetch } from '../../api'
import { defaultWorkspace, enterpriseApiBase, localEmployeeId, type ExecutionSettings } from '../../config'
import { createRuntimeTask, type CreateRuntimeTaskInput } from '../runtime/client'
import { buildBreakdownPrompt, buildCharacterExtractionPrompt } from './prompt'

type AuthContext = {
  authToken: string
  authUser: AccountUser | null
}

function employeeIdFrom(authUser: AccountUser | null) {
  return authUser?.id ?? localEmployeeId
}

export async function requestStoryboardBreakdown({
  script,
  authToken,
  authUser,
  executionSettings,
}: AuthContext & {
  script: string
  executionSettings: ExecutionSettings
}) {
  const input: CreateRuntimeTaskInput = {
    prompt: buildBreakdownPrompt(script),
    employeeId: employeeIdFrom(authUser),
    enterpriseApiBase,
    enterpriseAuthToken: authToken,
    workspace: defaultWorkspace,
    reasoningEffort: executionSettings.reasoningEffort,
    sandboxMode: executionSettings.sandboxMode,
  }
  return createRuntimeTask(input)
}

export async function requestCharacterExtraction({
  script,
  authToken,
  authUser,
  executionSettings,
}: AuthContext & {
  script: string
  executionSettings: ExecutionSettings
}) {
  const input: CreateRuntimeTaskInput = {
    prompt: buildCharacterExtractionPrompt(script),
    employeeId: employeeIdFrom(authUser),
    enterpriseApiBase,
    enterpriseAuthToken: authToken,
    workspace: defaultWorkspace,
    reasoningEffort: executionSettings.reasoningEffort,
    sandboxMode: executionSettings.sandboxMode,
  }
  return createRuntimeTask(input)
}

export async function generateShotImage({
  prompt,
  authToken,
  authUser,
  attachments = [],
}: AuthContext & {
  prompt: string
  attachments?: RuntimeAttachment[]
}): Promise<string> {
  const body = {
    prompt,
    size: '1024x1024',
    workspace: defaultWorkspace,
    employeeId: employeeIdFrom(authUser),
    enterpriseApiBase,
    enterpriseAuthToken: authToken,
    attachments,
  }
  const response = await runtimeFetch('/api/images/generations', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { data?: { id?: string }; error?: string }
  if (!response.ok || !payload.data?.id) {
    throw new Error(payload.error ?? `生图请求失败（${response.status}）`)
  }
  return payload.data.id
}

// 把遮脸后的 dataURL 上传到企业素材库，换成公网可访问的 https 地址，
// 这样它能被图生视频选用（视频服务需从公网拉取参考图）。
export async function uploadMaskedImage(dataUrl: string, authToken: string, name = 'masked.png'): Promise<string> {
  const response = await enterpriseFetch('/plugin-assets', authToken, {
    method: 'POST',
    body: JSON.stringify({ dataUrl, name, type: 'image/png' }),
    timeoutMs: 60000,
  })
  const payload = (await response.json()) as { data?: { url?: string }; error?: string }
  if (!response.ok || !payload.data?.url) {
    throw new Error(payload.error ?? `素材上传失败（${response.status}）`)
  }
  return payload.data.url
}
