import { finalAssistantContent, mergeAssistantContent, type CodexTask, type CodexTaskEvent } from '@eaw/shared'
import { applyTaskLifecycleEvent } from './lifecycle.js'
import type { TaskRecord } from './types.js'

type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error'

type AppendTranscriptItem = (
  record: TaskRecord,
  item: Omit<CodexTask['transcript'][number], 'seq' | 'turnId'> & Partial<Pick<CodexTask['transcript'][number], 'seq' | 'turnId'>>,
) => CodexTask['transcript'][number]

export type TaskEventBus = {
  eventSequence: (eventId: string, taskId: string) => number | undefined
  pushEvent: (record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) => void
  streamAssistantMessage: (record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) => Promise<void>
}

export function rawItemId(raw: unknown) {
  if (!raw || typeof raw !== 'object') return undefined
  const direct = firstString((raw as { itemId?: unknown }).itemId, (raw as { item_id?: unknown }).item_id)
  if (direct) return direct
  const item = (raw as { item?: unknown }).item
  if (!item || typeof item !== 'object') return undefined
  const id = firstString((item as { id?: unknown }).id, (item as { itemId?: unknown }).itemId, (item as { item_id?: unknown }).item_id)
  return id || undefined
}

export function rawWithItemId(raw: unknown, fallbackId: string) {
  if (rawItemId(raw)) return raw
  return { item: { id: fallbackId, type: 'agent_message' }, payload: raw }
}

export function appServerRaw(itemId: string) {
  return { item: { id: itemId, type: 'agent_message' } }
}

export function createTaskEventBus({
  appendTranscriptItem,
  isRuntimeFailureContent,
  logTask,
  saveStore,
  safeVisibleToolContent,
}: {
  appendTranscriptItem: AppendTranscriptItem
  isRuntimeFailureContent: (content: string) => boolean
  logTask: (record: TaskRecord, event: string, details?: unknown, level?: RuntimeLogLevel) => void
  saveStore: () => Promise<void>
  safeVisibleToolContent: (content: string) => string
}): TaskEventBus {
  function resolveAssistantItemId(record: TaskRecord, event: CodexTaskEvent) {
    if (event.role !== 'assistant') return undefined

    const explicitItemId = event.itemId ?? rawItemId(event.raw)
    if (explicitItemId) {
      record.activeAssistantItemId = explicitItemId
      return explicitItemId
    }

    if (event.type === 'message_delta') {
      record.activeAssistantItemId ??= `assistant-${record.task.id}-${record.events.length + 1}`
      return record.activeAssistantItemId
    }

    if (event.type === 'message' && record.activeAssistantItemId) return record.activeAssistantItemId

    return `assistant-${record.task.id}-${record.events.length + 1}`
  }

  function pushEvent(record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) {
    let next: CodexTaskEvent = {
      ...event,
      id: `${event.taskId}-${record.events.length + 1}`,
      turnId: event.turnId ?? record.currentTurnId,
      seq: record.events.length + 1,
      timestamp: new Date().toISOString(),
    }
    const assistantItemId = resolveAssistantItemId(record, next)
    if (assistantItemId) next = { ...next, itemId: assistantItemId }

    if (next.type === 'thread.started' && next.raw && typeof next.raw === 'object') {
      const threadId = (next.raw as { thread_id?: unknown }).thread_id
      if (typeof threadId === 'string') {
        record.task.sessionId = threadId
      }
    }

    if (!next.content && next.type !== 'thread.started') return

    record.events.push(next)
    const previousPhase = record.lifecycle?.phase
    applyTaskLifecycleEvent(record, next, isRuntimeFailureContent)
    const nextPhase = record.lifecycle?.phase
    const shouldLogEvent = next.type !== 'message_delta' || previousPhase !== nextPhase
    if (shouldLogEvent) {
      logTask(
        record,
        'task.event',
        {
          contentLength: next.content.length,
          contentPreview: previewLogContent(next.content),
          itemId: next.itemId,
          nextPhase,
          previousPhase,
          role: next.role,
          status: record.task.status,
          type: next.type,
        },
        next.type === 'turn.failed' || next.type === 'error' ? 'error' : next.type === 'process.exit' && record.task.status !== 'completed' ? 'warn' : 'debug',
      )
    }

    if (next.type === 'message_delta') {
      const itemId = next.itemId ?? `assistant-${record.events.length}`
      const existingIndex = record.streamItemIndexes.get(itemId)

      if (existingIndex === undefined) {
        record.streamItemIndexes.set(itemId, record.task.transcript.length)
        appendTranscriptItem(record, {
          role: 'assistant',
          content: next.content,
          eventId: next.id,
          itemId,
          timestamp: next.timestamp,
        })
      } else {
        const current = record.task.transcript[existingIndex]
        const content = mergeAssistantContent(current.content, next.content)
        record.task.transcript[existingIndex] = { ...current, content, eventId: next.id, timestamp: next.timestamp }
      }
    } else if (next.type === 'message' && next.role === 'assistant') {
      const itemId = next.itemId ?? rawItemId(next.raw)
      const existingIndex = itemId ? record.streamItemIndexes.get(itemId) : undefined
      if (existingIndex !== undefined) {
        const current = record.task.transcript[existingIndex]
        record.task.transcript[existingIndex] = { ...current, content: finalAssistantContent(current.content, next.content), eventId: next.id, timestamp: next.timestamp }
      } else if (record.task.transcript.at(-1)?.role !== 'assistant' || record.task.transcript.at(-1)?.content !== next.content) {
        appendTranscriptItem(record, {
          role: next.role,
          content: next.content,
          eventId: next.id,
          itemId,
          timestamp: next.timestamp,
        })
      }
      if (record.activeAssistantItemId === itemId) record.activeAssistantItemId = undefined
    } else if (next.content) {
      appendTranscriptItem(record, {
        role: next.role,
        content: next.content,
        eventId: next.id,
        itemId: next.itemId,
        timestamp: next.timestamp,
      })
    }

    record.task.updatedAt = next.timestamp
    if (next.role === 'tool' && next.content.startsWith('$ ')) {
      record.task.commandHistory = [...(record.task.commandHistory ?? []), safeVisibleToolContent(next.content)].slice(-80)
    }
    void saveStore()

    for (const subscriber of record.subscribers) {
      subscriber(next)
    }
  }

  async function streamAssistantMessage(record: TaskRecord, event: Omit<CodexTaskEvent, 'id' | 'timestamp'>) {
    const itemId = rawItemId(event.raw) ?? `assistant-final-${record.events.length + 1}`
    const raw = rawWithItemId(event.raw, itemId)

    if (record.streamItemIndexes.has(itemId)) {
      pushEvent(record, { ...event, raw })
      return
    }

    let visible = ''
    for (const chunk of assistantStreamChunks(event.content)) {
      visible += chunk
      pushEvent(record, {
        ...event,
        type: 'message_delta',
        content: visible,
        raw,
      })
      await sleep(18)
    }

    pushEvent(record, { ...event, raw })
  }

  return { eventSequence, pushEvent, streamAssistantMessage }
}

function eventSequence(eventId: string, taskId: string) {
  const prefix = `${taskId}-`
  if (!eventId.startsWith(prefix)) return undefined
  const value = Number(eventId.slice(prefix.length))
  return Number.isFinite(value) ? value : undefined
}

function assistantStreamChunks(content: string) {
  const chars = Array.from(content)
  const chunkSize = Math.max(1, Math.min(10, Math.ceil(chars.length / 90)))
  const chunks: string[] = []
  for (let index = 0; index < chars.length; index += chunkSize) {
    chunks.push(chars.slice(index, index + chunkSize).join(''))
  }
  return chunks
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function previewLogContent(content: string, maxLength = 240) {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, maxLength)}...`
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
