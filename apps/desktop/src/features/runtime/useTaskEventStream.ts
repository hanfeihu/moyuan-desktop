import { useEffect, useRef } from 'react'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import { logClientEvent } from '../../logger'
import type { RuntimeState } from './types'
import { subscribeRuntimeTaskEvents } from './client'

function taskLogSummary(task?: CodexTask | null) {
  if (!task) return undefined
  return {
    id: task.id,
    sessionId: task.sessionId,
    status: task.status,
    transcriptLength: task.transcript.length,
    workspace: task.workspace,
  }
}

function eventLogSummary(event: CodexTaskEvent) {
  return {
    contentLength: event.content.length,
    itemId: event.itemId,
    role: event.role,
    taskId: event.taskId,
    type: event.type,
  }
}

export function useTaskEventStream({
  activeTask,
  enabled,
  onEvent,
  onReconnect,
  onRuntimeState,
  reconnectNonce,
}: {
  activeTask: CodexTask
  enabled: boolean
  onEvent: (event: CodexTaskEvent) => void
  onReconnect: () => void
  onRuntimeState: (state: RuntimeState) => void
  reconnectNonce: number
}) {
  const seenEventsRef = useRef<Set<string>>(new Set())
  const lastEventIdByTaskIdRef = useRef<Record<string, string>>({})

  useEffect(() => {
    if (!enabled) return

    let retryTimer: number | undefined
    const after = lastEventIdByTaskIdRef.current[activeTask.id]

    logClientEvent('sse.connect.start', { ...taskLogSummary(activeTask), after }, 'debug')
    const close = subscribeRuntimeTaskEvents({
      after,
      taskId: activeTask.id,
      onOpen: () => {
        logClientEvent('sse.open', taskLogSummary(activeTask), 'debug')
      },
      onInvalidMessage: () => {
        logClientEvent('sse.message.invalid_json', { taskId: activeTask.id }, 'warn')
      },
      onMessage: (event) => {
        if (seenEventsRef.current.has(event.id)) {
          logClientEvent('sse.message.duplicate', eventLogSummary(event), 'debug')
          return
        }
        seenEventsRef.current.add(event.id)
        lastEventIdByTaskIdRef.current[event.taskId] = event.id
        logClientEvent(
          'sse.message',
          eventLogSummary(event),
          event.type === 'turn.failed' || event.type === 'error' ? 'error' : event.type === 'message_delta' ? 'debug' : 'info',
        )
        onRuntimeState('online')
        onEvent(event)
      },
      onError: () => {
        logClientEvent('sse.error', taskLogSummary(activeTask), 'warn')
        close()
        retryTimer = window.setTimeout(onReconnect, 1500)
      },
    })

    return () => {
      logClientEvent('sse.close', taskLogSummary(activeTask), 'debug')
      close()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [activeTask.id, activeTask.status, enabled, onEvent, onReconnect, onRuntimeState, reconnectNonce])
}
