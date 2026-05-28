import { useEffect } from 'react'
import type { CodexTask } from '@eaw/shared'
import { errorLogDetails, logClientEvent } from '../../logger'
import { runtimeUrl } from '../../config'
import type { RuntimeState } from './types'
import { checkRuntimeHealth, listRuntimeTasks } from './client'

export function useRuntimeBootstrap({
  authState,
  onLoadFailed,
  onRuntimeState,
  onTasksLoaded,
}: {
  authState: string
  onLoadFailed: () => void
  onRuntimeState: (state: RuntimeState) => void
  onTasksLoaded: (tasks: CodexTask[]) => void
}) {
  useEffect(() => {
    if (authState !== 'signed-in') return

    logClientEvent('runtime.health.check', { runtimeUrl }, 'debug')
    checkRuntimeHealth()
      .then(() => {
        logClientEvent('runtime.health.online', undefined, 'debug')
        onRuntimeState('online')
      })
      .catch((error) => {
        logClientEvent('runtime.health.offline', errorLogDetails(error, { runtimeUrl }), 'warn')
        onRuntimeState('offline')
      })

    logClientEvent('tasks.load.start', undefined, 'debug')
    listRuntimeTasks()
      .then((tasks) => {
        onRuntimeState('online')
        logClientEvent('tasks.load.success', { count: tasks.length }, 'debug')
        onTasksLoaded(tasks)
      })
      .catch((error) => {
        logClientEvent('tasks.load.failed', errorLogDetails(error, { runtimeUrl }), 'warn')
        onRuntimeState('offline')
        onLoadFailed()
      })
  }, [authState, onLoadFailed, onRuntimeState, onTasksLoaded])
}
