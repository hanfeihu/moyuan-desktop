import { useEffect, useRef } from 'react'
import type { CodexTask } from '@eaw/shared'
import { errorLogDetails, logClientEvent } from '../../logger'
import type { RuntimeState } from './types'
import { checkRuntimeHealth, getRuntimeTask } from './client'

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

function isLiveTask(task: CodexTask) {
  return task.status === 'queued' || task.status === 'running'
}

export function useLiveTaskPolling({
  authState,
  onTaskMissing,
  onRuntimeState,
  onTaskSnapshot,
  onUnwatchTask,
  watchedTaskIdsKey,
}: {
  authState: string
  onTaskMissing: (taskId: string) => void
  onRuntimeState: (state: RuntimeState) => void
  onTaskSnapshot: (task: CodexTask) => void
  onUnwatchTask: (taskId: string) => void
  watchedTaskIdsKey: string
}) {
  const lastPolledSnapshotRef = useRef<Record<string, string>>({})
  const healthFailureCountRef = useRef(0)

  useEffect(() => {
    if (authState !== 'signed-in' || !watchedTaskIdsKey) return

    const taskIds = watchedTaskIdsKey.split('|').filter(Boolean)
    let cancelled = false

    async function pollTask(taskId: string, reason: string) {
      try {
        const task = await getRuntimeTask(taskId)
        if (cancelled || !task) return

        onRuntimeState('online')
        const snapshotKey = `${task.status}:${task.transcript.length}:${task.updatedAt}`
        if (lastPolledSnapshotRef.current[taskId] !== snapshotKey) {
          lastPolledSnapshotRef.current[taskId] = snapshotKey
          logClientEvent('task.poll.changed', { reason, ...taskLogSummary(task) }, 'debug')
        }
        onTaskSnapshot(task)
        if (!isLiveTask(task)) onUnwatchTask(taskId)
      } catch (error) {
        if (cancelled) return
        logClientEvent('task.poll.failed', errorLogDetails(error, { reason, taskId }), 'warn')
        const message = error instanceof Error ? error.message : ''
        if (message.includes('任务不存在') || message.includes('Runtime 返回 404')) {
          onTaskMissing(taskId)
          onUnwatchTask(taskId)
          return
        }
        try {
          await checkRuntimeHealth()
          if (cancelled) return
          healthFailureCountRef.current = 0
          onRuntimeState('online')
          logClientEvent('task.poll.health_recovered', { reason, taskId }, 'debug')
        } catch (healthError) {
          if (cancelled) return
          healthFailureCountRef.current += 1
          logClientEvent(
            'task.poll.health_failed',
            errorLogDetails(healthError, { failures: healthFailureCountRef.current, reason, taskId }),
            'warn',
          )
          if (healthFailureCountRef.current >= 3) onRuntimeState('offline')
        }
      }
    }

    function pollAll(reason: string) {
      taskIds.forEach((taskId) => {
        void pollTask(taskId, reason)
      })
    }

    logClientEvent('task.poll.live.start', { taskIds }, 'debug')
    pollAll('live-start')
    const pollTimer = window.setInterval(() => pollAll('live-interval'), 2500)

    return () => {
      cancelled = true
      window.clearInterval(pollTimer)
      logClientEvent('task.poll.live.stop', { taskIds }, 'debug')
    }
  }, [authState, onRuntimeState, onTaskMissing, onTaskSnapshot, onUnwatchTask, watchedTaskIdsKey])
}
