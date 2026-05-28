import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import { runtimeEndpoint, runtimeFetch } from '../../api'
import type { ExecutionSettings } from '../../config'

type RuntimePayload<T> = {
  data?: T
  error?: string
}

export type CreateRuntimeTaskInput = {
  employeeId: string
  enterpriseApiBase: string
  enterpriseAuthToken: string
  parentTaskId?: string
  prompt: string
  reasoningEffort?: ExecutionSettings['reasoningEffort']
  sandboxMode?: ExecutionSettings['sandboxMode']
  sessionId?: string
  workspace: string
}

async function readRuntimePayload<T>(response: Response) {
  const payload = (await response.json()) as RuntimePayload<T>
  if (!response.ok) throw new Error(payload.error ?? `Runtime 返回 ${response.status}`)
  return payload
}

export async function checkRuntimeHealth() {
  const response = await runtimeFetch('/health')
  if (!response.ok) throw new Error('offline')
}

export async function listRuntimeTasks() {
  const response = await runtimeFetch('/api/codex/tasks')
  const payload = await readRuntimePayload<CodexTask[]>(response)
  return payload.data ?? []
}

export async function getRuntimeTask(taskId: string) {
  const response = await runtimeFetch(`/api/codex/tasks/${taskId}`)
  const payload = await readRuntimePayload<CodexTask>(response)
  return payload.data
}

export async function createRuntimeTask(input: CreateRuntimeTaskInput) {
  const response = await runtimeFetch('/api/codex/tasks', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  const payload = await readRuntimePayload<CodexTask>(response)
  if (!payload.data) throw new Error(payload.error ?? '任务创建失败')
  return payload.data
}

export async function cancelRuntimeTask(taskId: string) {
  const response = await runtimeFetch(`/api/codex/tasks/${taskId}/cancel`, {
    method: 'POST',
  })
  const payload = await readRuntimePayload<CodexTask>(response)
  if (!payload.data) throw new Error(payload.error ?? '停止失败')
  return payload.data
}

export function subscribeRuntimeTaskEvents({
  after,
  onError,
  onInvalidMessage,
  onMessage,
  onOpen,
  taskId,
}: {
  after?: string
  onError: () => void
  onInvalidMessage?: () => void
  onMessage: (event: CodexTaskEvent) => void
  onOpen?: () => void
  taskId: string
}) {
  const eventsPath = `/api/codex/tasks/${taskId}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`
  const source = new EventSource(runtimeEndpoint(eventsPath))

  source.onopen = () => onOpen?.()
  source.onmessage = (message) => {
    try {
      onMessage(JSON.parse(message.data) as CodexTaskEvent)
    } catch {
      onInvalidMessage?.()
    }
  }
  source.onerror = () => onError()

  return () => source.close()
}
