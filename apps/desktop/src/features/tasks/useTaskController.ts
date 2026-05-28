import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { AccountUser, CodexTask, CodexTaskEvent } from '@eaw/shared'
import { runtimeEndpoint, runtimeFetch } from '../../api'
import { defaultWorkspace, enterpriseApiBase, localEmployeeId, runtimeUrl } from '../../config'
import { errorLogDetails, logClientEvent } from '../../logger'
import { loadSignedInUser } from '../auth/useAuth'
import type { RuntimeState } from '../runtime/types'
import {
  appendPendingTurn,
  buildLocalErrorTask,
  buildPendingTask,
  canResumeTask,
  mergeEventIntoTask,
  mergeTask,
  normalizeTask,
  nowIso,
  replaceTask,
  shouldShowMessage,
  taskSortValue,
} from '../../tasks'
import { welcomeTask } from './welcomeTask'

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

function isLiveTask(task: CodexTask) {
  return task.status === 'queued' || task.status === 'running'
}

function isRuntimeTaskId(taskId: string) {
  return taskId !== 'welcome' && !taskId.startsWith('pending-') && !taskId.startsWith('error-')
}

function shouldWatchRuntimeTask(task?: CodexTask | null) {
  return Boolean(task && isRuntimeTaskId(task.id) && isLiveTask(task))
}

export function useTaskController({
  authState,
  authToken,
  authUser,
  onAfterSelectTask,
  onFocusComposer,
  onPinToBottom,
  setAuthUser,
}: {
  authState: string
  authToken: string
  authUser: AccountUser | null
  onAfterSelectTask: () => void
  onFocusComposer: () => void
  onPinToBottom: () => void
  setAuthUser: Dispatch<SetStateAction<AccountUser | null>>
}) {
  const [tasks, setTasks] = useState<CodexTask[]>([welcomeTask])
  const [activeTaskId, setActiveTaskId] = useState(welcomeTask.id)
  const [draftByTaskId, setDraftByTaskId] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [nowTick, setNowTick] = useState(Date.now())
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('checking')
  const [quotaNotice, setQuotaNotice] = useState('')
  const [sseReconnectNonce, setSseReconnectNonce] = useState(0)
  const [watchedTaskIds, setWatchedTaskIds] = useState<string[]>([])
  const seenEventsRef = useRef<Set<string>>(new Set())
  const lastEventIdByTaskIdRef = useRef<Record<string, string>>({})
  const lastPolledSnapshotRef = useRef<Record<string, string>>({})
  const workspace = defaultWorkspace

  const activeTask = useMemo(() => {
    if (activeTaskId === welcomeTask.id) return welcomeTask
    return tasks.find((task) => task.id === activeTaskId) ?? tasks[0] ?? welcomeTask
  }, [activeTaskId, tasks])
  const liveTaskIds = useMemo(() => tasks.filter(shouldWatchRuntimeTask).map((task) => task.id).sort().join('|'), [tasks])
  const watchedTaskIdsKey = useMemo(() => watchedTaskIds.slice().sort().join('|'), [watchedTaskIds])
  const visibleTranscript = useMemo(() => activeTask.transcript.filter(shouldShowMessage), [activeTask.transcript])
  const isWelcome = activeTask.id === 'welcome'
  const isBusy = isLiveTask(activeTask)
  const latestVisibleItem = visibleTranscript.at(-1)
  const shouldShowThinking = isBusy && latestVisibleItem?.role !== 'assistant'
  const latestUserTurn = useMemo(() => [...activeTask.transcript].reverse().find((item) => item.role === 'user'), [activeTask.transcript])
  const busyStartedAt = new Date(latestUserTurn?.timestamp ?? activeTask.createdAt ?? nowIso()).getTime()
  const busyElapsed = isBusy ? Math.max(0, nowTick - busyStartedAt) : 0
  const prompt = draftByTaskId[activeTask.id] ?? ''
  const remainingTokens = authUser ? authUser.tokenBudget - authUser.tokenUsed : 0
  const quotaDepleted = remainingTokens <= 0
  const placeholder = quotaDepleted ? '等待管理员派发 Token 额度' : isBusy ? '当前任务运行中，完成后继续发送' : '让墨渊做点什么...'
  const canSubmit = !isSubmitting && !isBusy && !quotaDepleted && Boolean(prompt.trim())
  const showStatusBadge = !isWelcome && (activeTask.status !== 'completed' || runtimeState === 'offline')

  function setPrompt(value: string, taskId = activeTask.id) {
    setDraftByTaskId((current) => ({ ...current, [taskId]: value }))
  }

  function selectTask(taskId: string) {
    logClientEvent('task.select', { fromTaskId: activeTask?.id, taskId }, 'debug')
    onPinToBottom()
    setActiveTaskId(taskId)
    window.requestAnimationFrame(() => {
      onAfterSelectTask()
      onFocusComposer()
    })
  }

  function startNewConversation() {
    logClientEvent('task.new_conversation', { fromTaskId: activeTask?.id })
    setPrompt('', welcomeTask.id)
    selectTask(welcomeTask.id)
  }

  function resetTasks() {
    logClientEvent('task.reset')
    setQuotaNotice('')
    setTasks([welcomeTask])
    setActiveTaskId(welcomeTask.id)
  }

  useEffect(() => {
    if (authState !== 'signed-in') return

    logClientEvent('runtime.health.check', { runtimeUrl }, 'debug')
    runtimeFetch('/health')
      .then((response) => {
        if (!response.ok) throw new Error('offline')
        logClientEvent('runtime.health.online', { status: response.status }, 'debug')
        setRuntimeState('online')
      })
      .catch((error) => {
        logClientEvent('runtime.health.offline', errorLogDetails(error, { runtimeUrl }), 'warn')
        setRuntimeState('offline')
      })

    logClientEvent('tasks.load.start', undefined, 'debug')
    runtimeFetch('/api/codex/tasks')
      .then((response) => response.json())
      .then((payload: { data?: CodexTask[] }) => {
        setRuntimeState('online')
        logClientEvent('tasks.load.success', { count: payload.data?.length ?? 0 }, 'debug')
        if (payload.data?.length) {
          const nextTasks = payload.data.map(normalizeTask).sort((a, b) => taskSortValue(b) - taskSortValue(a))
          setTasks(nextTasks)
          setActiveTaskId((current) => (current === welcomeTask.id ? nextTasks[0]?.id ?? current : current))
        }
      })
      .catch((error) => {
        logClientEvent('tasks.load.failed', errorLogDetails(error, { runtimeUrl }), 'warn')
        setRuntimeState('offline')
        setTasks([
          {
            ...welcomeTask,
            transcript: [
              ...welcomeTask.transcript,
              {
                role: 'system',
                content: `Codex Runtime 没连上：${runtimeUrl}`,
                timestamp: nowIso(),
              },
            ],
          },
        ])
      })
  }, [authState])

  useEffect(() => {
    if (!isBusy) return
    setNowTick(Date.now())
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isBusy, activeTask?.id])

  useEffect(() => {
    if (authState !== 'signed-in' || !liveTaskIds) return
    const ids = liveTaskIds.split('|').filter(Boolean)
    setWatchedTaskIds((current) => Array.from(new Set([...current, ...ids])).sort())
  }, [authState, liveTaskIds])

  useEffect(() => {
    if (authState !== 'signed-in' || !watchedTaskIdsKey) return

    const taskIds = watchedTaskIdsKey.split('|').filter(Boolean)
    let cancelled = false

    async function pollTask(taskId: string, reason: string) {
      try {
        const response = await runtimeFetch(`/api/codex/tasks/${taskId}`)
        const payload = (await response.json()) as { data?: CodexTask }
        if (cancelled) return

        setRuntimeState('online')
        if (payload.data) {
          const snapshotKey = `${payload.data.status}:${payload.data.transcript.length}:${payload.data.updatedAt}`
          if (lastPolledSnapshotRef.current[taskId] !== snapshotKey) {
            lastPolledSnapshotRef.current[taskId] = snapshotKey
            logClientEvent('task.poll.changed', { reason, ...taskLogSummary(payload.data) }, 'debug')
          }
          setTasks((current) => mergeTask(current, payload.data!))
          if (!isLiveTask(payload.data)) {
            setWatchedTaskIds((current) => current.filter((id) => id !== taskId))
          }
        }
      } catch (error) {
        if (cancelled) return
        logClientEvent('task.poll.failed', errorLogDetails(error, { reason, taskId }), 'warn')
        setRuntimeState('offline')
      }
    }

    function pollAll(reason: string) {
      taskIds.forEach((taskId) => {
        void pollTask(taskId, reason)
      })
    }

    logClientEvent('task.poll.live.start', { taskIds }, 'debug')
    pollAll('live-start')
    const pollTimer = window.setInterval(() => pollAll('live-interval'), 1200)

    return () => {
      cancelled = true
      window.clearInterval(pollTimer)
      logClientEvent('task.poll.live.stop', { taskIds }, 'debug')
    }
  }, [authState, watchedTaskIdsKey])

  useEffect(() => {
    if (!shouldWatchRuntimeTask(activeTask)) return

    let retryTimer: number | undefined

    const after = lastEventIdByTaskIdRef.current[activeTask.id]
    const eventsPath = `/api/codex/tasks/${activeTask.id}/events${after ? `?after=${encodeURIComponent(after)}` : ''}`
    logClientEvent('sse.connect.start', { ...taskLogSummary(activeTask), after }, 'debug')
    const source = new EventSource(runtimeEndpoint(eventsPath))

    source.onopen = () => {
      logClientEvent('sse.open', taskLogSummary(activeTask), 'debug')
    }

    source.onmessage = (message) => {
      let event: CodexTaskEvent
      try {
        event = JSON.parse(message.data) as CodexTaskEvent
      } catch {
        logClientEvent('sse.message.invalid_json', { taskId: activeTask.id }, 'warn')
        return
      }
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
      setRuntimeState('online')
      setTasks((current) => current.map((task) => (task.id === event.taskId ? mergeEventIntoTask(task, event) : task)))
    }

    source.onerror = () => {
      logClientEvent('sse.error', taskLogSummary(activeTask), 'warn')
      source.close()
      retryTimer = window.setTimeout(() => {
        setSseReconnectNonce((value) => value + 1)
      }, 1500)
    }

    return () => {
      logClientEvent('sse.close', taskLogSummary(activeTask), 'debug')
      source.close()
      if (retryTimer) window.clearTimeout(retryTimer)
    }
  }, [activeTask?.id, activeTask?.status, sseReconnectNonce])

  async function stopActiveTask() {
    if (!isBusy || isCancelling || activeTask.id === 'welcome') return

    logClientEvent('task.stop.start', taskLogSummary(activeTask), 'warn')
    setIsCancelling(true)
    try {
      const response = await runtimeFetch(`/api/codex/tasks/${activeTask.id}/cancel`, {
        method: 'POST',
      })
      const payload = (await response.json()) as { data?: CodexTask; error?: string }
      if (!response.ok || !payload.data) throw new Error(payload.error ?? '停止失败')
      logClientEvent('task.stop.success', taskLogSummary(payload.data))
      setRuntimeState('online')
      setTasks((current) => mergeTask(current, payload.data!))
    } catch (error) {
      const message = error instanceof Error ? error.message : '停止失败'
      logClientEvent('task.stop.failed', errorLogDetails(error, taskLogSummary(activeTask)), 'error')
      setTasks((current) =>
        current.map((task) =>
          task.id === activeTask.id
            ? {
                ...task,
                status: 'failed',
                transcript: [
                  ...task.transcript,
                  {
                    role: 'system',
                    content: `停止失败：${message}`,
                    timestamp: nowIso(),
                  },
                ],
              }
            : task,
        ),
      )
    } finally {
      setIsCancelling(false)
      window.requestAnimationFrame(onFocusComposer)
    }
  }

  async function submitTask() {
    const promptText = prompt.trim()
    const workspacePath = workspace.trim() || defaultWorkspace
    if (!promptText || isSubmitting || isBusy || !authToken) return
    if (quotaDepleted) {
      logClientEvent('task.submit.quota_depleted', { remainingTokens })
      setQuotaNotice('当前没有可用 Token，等待管理员在后台派发额度。')
      window.setTimeout(() => setQuotaNotice(''), 3600)
      return
    }

    let currentUser = authUser
    logClientEvent('task.submit.preflight', {
      activeTask: taskLogSummary(activeTask),
      promptLength: promptText.length,
      workspace: workspacePath,
    })
    setIsSubmitting(true)
    try {
      const freshUser = await loadSignedInUser(authToken)
      currentUser = freshUser
      setAuthUser(freshUser)
      if (freshUser.tokenBudget - freshUser.tokenUsed <= 0) {
        logClientEvent('task.submit.quota_depleted_after_refresh', { tokenBudget: freshUser.tokenBudget, tokenUsed: freshUser.tokenUsed }, 'warn')
        setQuotaNotice('当前没有可用 Token，等待管理员在后台派发额度。')
        window.setTimeout(() => setQuotaNotice(''), 3600)
        setIsSubmitting(false)
        return
      }
    } catch (error) {
      logClientEvent('task.submit.preflight_failed', errorLogDetails(error, { runtimeState }), 'warn')
      setRuntimeState('offline')
      setIsSubmitting(false)
      return
    }

    onPinToBottom()
    const shouldResume = activeTask.id !== 'welcome' && canResumeTask(activeTask)
    logClientEvent('task.submit.local_pending', {
      shouldResume,
      sourceTask: taskLogSummary(activeTask),
      workspace: workspacePath,
    })
    const pendingTask = shouldResume ? appendPendingTurn(activeTask, promptText, workspacePath) : buildPendingTask(promptText, workspacePath)
    setTasks((current) => mergeTask(current, pendingTask))
    setActiveTaskId(pendingTask.id)
    setPrompt('')

    try {
      const response = await runtimeFetch('/api/codex/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: currentUser?.id ?? localEmployeeId,
          enterpriseApiBase,
          enterpriseAuthToken: authToken,
          workspace: workspacePath,
          prompt: promptText,
          parentTaskId: shouldResume ? activeTask.id : undefined,
          sessionId: shouldResume ? activeTask.sessionId : undefined,
        }),
      })
      const payload = (await response.json()) as { data?: CodexTask; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Runtime 返回 ${response.status}`)
      if (!payload.data) throw new Error(payload.error ?? '任务创建失败')
      logClientEvent('task.submit.accepted', {
        pendingTaskId: pendingTask.id,
        shouldResume,
        task: taskLogSummary(payload.data),
      })
      setRuntimeState('online')
      if (isLiveTask(payload.data)) {
        setWatchedTaskIds((current) => Array.from(new Set([...current, payload.data!.id])).sort())
      }
      setTasks((current) => (shouldResume ? mergeTask(current, payload.data!) : replaceTask(current, pendingTask.id, payload.data!)))
      setActiveTaskId(payload.data.id)
    } catch (error) {
      logClientEvent('task.submit.failed', errorLogDetails(error, {
        pendingTaskId: pendingTask.id,
        shouldResume,
        sourceTask: taskLogSummary(activeTask),
      }), 'error')
      setRuntimeState('offline')
      const errorTask = buildLocalErrorTask(error, workspacePath)
      setTasks((current) => (shouldResume ? mergeTask(current, errorTask) : replaceTask(current, pendingTask.id, errorTask)))
      setActiveTaskId(shouldResume ? activeTask.id : errorTask.id)
    } finally {
      setIsSubmitting(false)
      window.requestAnimationFrame(onFocusComposer)
    }
  }

  return {
    activeTask,
    busyElapsed,
    canSubmit,
    isBusy,
    isCancelling,
    isSubmitting,
    isWelcome,
    placeholder,
    prompt,
    quotaDepleted,
    quotaNotice,
    resetTasks,
    runtimeState,
    selectTask,
    setPrompt,
    shouldShowThinking,
    showStatusBadge,
    startNewConversation,
    stopActiveTask,
    submitTask,
    tasks,
    visibleTranscript,
  }
}
