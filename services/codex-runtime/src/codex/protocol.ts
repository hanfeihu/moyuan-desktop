import { createHash } from 'node:crypto'
import type { CodexTaskEvent, RuntimePlanStep, RuntimeTaskItem } from '@eaw/shared'
import { rawItemId } from '../tasks/events.js'

export function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

export function normalizedType(value: unknown) {
  return typeof value === 'string' ? value.replace(/[_-]/g, '').toLowerCase() : ''
}

export function isAgentMessageItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  return normalizedType(item?.type) === 'agentmessage'
}

export function isCommandExecutionItem(item: Record<string, unknown> | null): item is Record<string, unknown> {
  return normalizedType(item?.type) === 'commandexecution'
}

export function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''

  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      return firstString(record.text, record.content, record.value)
    })
    .filter(Boolean)
    .join('')
}

export function codexUsageFromPayload(payload: unknown) {
  const usage = findUsagePayload(payload)
  if (!usage) return undefined
  const promptTokens = numericUsage(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens)
  const completionTokens = numericUsage(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens)
  const totalTokens = numericUsage(usage.total_tokens ?? usage.totalTokens) || promptTokens + completionTokens
  if (!totalTokens) return undefined
  return { completionTokens, promptTokens, totalTokens }
}

export function usageReportId(taskId: string, payload: unknown) {
  const digest = createHash('sha256').update(compactJson(payload)).digest('hex').slice(0, 16)
  const fromPayload = firstString(
    (payload as { id?: unknown })?.id,
    (payload as { turn_id?: unknown })?.turn_id,
    (payload as { turnId?: unknown })?.turnId,
    (payload as { turn?: { id?: unknown } })?.turn?.id,
  )
  return `codex:${taskId}:${fromPayload || digest}`
}

export function assistantTextFromItem(item: Record<string, unknown> | null, params?: Record<string, unknown>) {
  if (!item) return ''
  return firstString(
    item.text,
    item.outputText,
    item.output_text,
    item.message,
    textFromContent(item.content),
    params?.text,
    params?.outputText,
    params?.output_text,
    params?.message,
    textFromContent(params?.content),
  )
}

export function assistantDeltaFromParams(params: Record<string, unknown>) {
  return firstString(params.delta, params.text, params.outputText, params.output_text, params.message, textFromContent(params.content))
}

export function eventFromJson(taskId: string, payload: unknown, maxVisibleToolOutput = 6000): Omit<CodexTaskEvent, 'id' | 'timestamp'> {
  const obj = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const type = typeof obj.type === 'string' ? obj.type : 'message'
  const message = typeof obj.message === 'string' ? obj.message : ''
  const item = obj.item && typeof obj.item === 'object' ? (obj.item as Record<string, unknown>) : null
  const itemId = rawItemId(payload)

  if (type === 'item.updated' && isAgentMessageItem(item)) {
    const content = firstString(item.text, item.delta, obj.delta, obj.text, textFromContent(item.content), textFromContent(obj.content))

    return {
      taskId,
      type: 'message_delta',
      role: 'assistant',
      content,
      itemId,
      raw: payload,
    }
  }

  if (type === 'item.completed' && isAgentMessageItem(item)) {
    return {
      taskId,
      type: 'message',
      role: 'assistant',
      content: assistantTextFromItem(item, obj),
      itemId,
      raw: payload,
    }
  }

  if ((type === 'item.started' || type === 'item.completed') && isCommandExecutionItem(item)) {
    const structuredItem = runtimeItemFromCodexItem(item, type)
    if (type === 'item.started') {
      return {
        taskId,
        type: 'item.started',
        role: 'tool',
        content: '',
        item: structuredItem,
        itemId,
        raw: payload,
      }
    }

    const command = firstString(item.command, item.commandLine, item.command_line)
    const output = truncateMiddle(firstString(item.aggregated_output, item.aggregatedOutput, item.output).trim(), maxVisibleToolOutput)
    const status = typeof item.status === 'string' ? item.status : 'completed'
    const rawExitCode = typeof item.exit_code === 'number' ? item.exit_code : typeof item.exitCode === 'number' ? item.exitCode : undefined
    const exitCode = typeof rawExitCode === 'number' ? `\nexit ${rawExitCode}` : ''
    const body = output ? `$ ${command}\n${output}${exitCode}` : `$ ${command}\n${status}`

    return {
      taskId,
      type: 'tool',
      role: 'tool',
      content: body,
      item: structuredItem,
      itemId,
      raw: payload,
    }
  }

  if (type === 'item.started' || type === 'item.completed') {
    const structuredItem = runtimeItemFromCodexItem(item, type)
    return {
      taskId,
      type: type === 'item.started' ? 'item.started' : 'item.completed',
      role: 'system',
      content: '',
      item: structuredItem,
      itemId: structuredItem?.id,
      raw: payload,
    }
  }

  if (type === 'turn.plan.updated' || type === 'plan.updated') {
    const plan = runtimePlanFromPayload(obj)
    return {
      taskId,
      type: 'plan.updated',
      role: 'system',
      content: '',
      plan,
      raw: payload,
    }
  }

  if (type.includes('error') || type === 'turn.failed') {
    return {
      taskId,
      type: type === 'turn.failed' ? 'turn.failed' : 'error',
      role: 'system',
      content: message || compactJson(payload),
      raw: payload,
    }
  }

  if (type.includes('exec') || type.includes('tool')) {
    return {
      taskId,
      type: 'tool',
      role: 'tool',
      content: message,
      raw: payload,
    }
  }

  if (type === 'turn.completed') {
    return { taskId, type: 'turn.completed', role: 'system', content: '任务完成', raw: payload }
  }

  if (type === 'thread.started' || type === 'turn.started') {
    return { taskId, type, role: 'system', content: '', raw: payload }
  }

  if (!message) {
    return {
      taskId,
      type: 'message',
      role: 'system',
      content: '',
      raw: payload,
    }
  }

  return {
    taskId,
    type: 'message',
    role: 'assistant',
    content: message,
    raw: payload,
  }
}

export function runtimeItemFromCodexItem(item: Record<string, unknown> | null, eventType = ''): RuntimeTaskItem | undefined {
  if (!item) return undefined
  const id = firstString(item.id, item.itemId, item.item_id)
  if (!id) return undefined
  const rawType = normalizedType(item.type)
  const status = runtimeItemStatus(firstString(item.status), eventType)
  const metadata = { ...item }

  if (rawType === 'commandexecution') {
    const command = firstString(item.command, item.commandLine, item.command_line)
    return {
      id,
      type: 'command',
      title: command ? `运行命令：${command}` : '运行命令',
      status,
      content: firstString(item.aggregatedOutput, item.aggregated_output, item.output),
      metadata,
    }
  }

  if (rawType === 'filechange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes
      .map((change) => (change && typeof change === 'object' ? firstString((change as { path?: unknown }).path) : ''))
      .filter(Boolean)
    return {
      id,
      type: 'file_change',
      title: paths.length ? `修改文件：${paths.slice(0, 3).join(', ')}` : '修改文件',
      status,
      summary: paths.join('\n'),
      metadata,
    }
  }

  if (rawType === 'mcptoolcall' || rawType === 'dynamictoolcall') {
    const tool = firstString(item.tool, item.toolName, item.tool_name)
    const server = firstString(item.server, item.namespace)
    return {
      id,
      type: rawType === 'dynamictoolcall' ? 'plugin' : 'tool_call',
      title: [server, tool].filter(Boolean).join(' / ') || '调用工具',
      status,
      metadata,
    }
  }

  if (rawType === 'websearch') {
    const query = firstString(item.query)
    return { id, type: 'web_search', title: query ? `网页搜索：${query}` : '网页搜索', status, metadata }
  }

  if (rawType === 'imagegeneration') {
    return {
      id,
      type: 'image_generation',
      title: '生成图片',
      status,
      content: firstString(item.result, item.savedPath, item.saved_path),
      metadata,
    }
  }

  if (rawType === 'agentmessage') {
    return { id, type: 'assistant_message', title: '生成回复', status, content: assistantTextFromItem(item), metadata }
  }

  if (rawType === 'reasoning') return { id, type: 'reasoning', title: '思考', status, metadata }
  return { id, type: 'system', title: firstString(item.type) || '任务事件', status, metadata }
}

export function runtimePlanFromPayload(payload: Record<string, unknown>): RuntimePlanStep[] {
  const plan = Array.isArray(payload.plan) ? payload.plan : []
  return plan
    .map((step) => {
      if (!step || typeof step !== 'object') return undefined
      const record = step as Record<string, unknown>
      const text = firstString(record.step, record.text, record.title)
      if (!text) return undefined
      return {
        step: text,
        status: runtimePlanStatus(firstString(record.status)),
      }
    })
    .filter((step): step is RuntimePlanStep => Boolean(step))
}

function runtimeItemStatus(value: string, eventType: string): RuntimeTaskItem['status'] {
  const normalized = normalizedType(value)
  if (eventType === 'item.started') return 'in_progress'
  if (normalized === 'inprogress' || normalized === 'running') return 'in_progress'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'declined') return 'declined'
  if (eventType === 'item.completed' || normalized === 'completed' || normalized === 'succeeded') return 'completed'
  return 'pending'
}

function runtimePlanStatus(value: string): RuntimePlanStep['status'] {
  const normalized = normalizedType(value)
  if (normalized === 'inprogress' || normalized === 'running') return 'in_progress'
  if (normalized === 'completed' || normalized === 'done') return 'completed'
  return 'pending'
}

function findUsagePayload(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findUsagePayload(item)
      if (found) return found
    }
    return undefined
  }

  const record = payload as Record<string, unknown>
  const direct = record.usage
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct as Record<string, unknown>
  if ('input_tokens' in record || 'output_tokens' in record || 'total_tokens' in record) return record
  for (const value of Object.values(record)) {
    const found = findUsagePayload(value)
    if (found) return found
  }
  return undefined
}

function numericUsage(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0
}

function compactJson(payload: unknown) {
  try {
    return JSON.stringify(payload)
  } catch {
    return ''
  }
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  const headLength = Math.floor(maxLength * 0.65)
  const tailLength = Math.max(0, maxLength - headLength - 80)
  return `${value.slice(0, headLength)}\n\n... 输出过长，已截断 ${value.length - headLength - tailLength} 个字符 ...\n\n${value.slice(-tailLength)}`
}
