import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { AccountUser, CodexTask, CodexTaskEvent, RuntimeAttachment } from '@eaw/shared'
import { defaultWorkspace, enterpriseApiBase, localEmployeeId, runtimeUrl, type ExecutionSettings } from '../../config'
import { uploadDiagnosticsSnapshot } from '../../diagnostics'
import { errorLogDetails, logClientEvent } from '../../logger'
import { loadSignedInUser } from '../auth/useAuth'
import type { RuntimeState } from '../runtime/types'
import { cancelRuntimeTask, createRuntimeTask, deferRuntimePluginInput, submitRuntimePluginInput } from '../runtime/client'
import { attachmentForPersistence, revokeAttachmentPreview } from '../chat/attachments'
import { conversationImages, type ConversationImage } from '../chat/conversationImages'
import { BREAKDOWN_PROMPT_MARKER, CHARACTER_EXTRACTION_MARKER } from '../storyboard/prompt'
import { useLiveTaskPolling } from '../runtime/useLiveTaskPolling'
import { useRuntimeBootstrap } from '../runtime/useRuntimeBootstrap'
import { useTaskEventStream } from '../runtime/useTaskEventStream'
import { useBusyElapsed } from './useBusyElapsed'
import { useTaskDrafts } from './useTaskDrafts'
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

function isLiveTask(task: CodexTask) {
  return task.status === 'queued' || task.status === 'running'
}

function isRuntimeTaskId(taskId: string) {
  return taskId !== 'welcome' && !taskId.startsWith('pending-') && !taskId.startsWith('error-')
}

// 短剧分镜功能产生的「辅助任务」：逐镜/定妆生图(image-*)、拆分镜 LLM 调用。
// 这些是后台中间产物，不应污染左侧对话列表。
function isAuxiliaryTask(task?: CodexTask | null) {
  if (!task) return false
  if (task.id.startsWith('image-')) return true
  const firstUser = task.transcript.find((item) => item.role === 'user')
  const probe = firstUser?.content ?? task.title ?? ''
  return probe.startsWith(BREAKDOWN_PROMPT_MARKER) || probe.startsWith(CHARACTER_EXTRACTION_MARKER)
}

function shouldWatchRuntimeTask(task?: CodexTask | null) {
  return Boolean(task && isRuntimeTaskId(task.id) && isLiveTask(task))
}

const SUBMIT_AUTH_REFRESH_TIMEOUT_MS = 5000
const SUBMIT_AUTH_REQUIRED_TIMEOUT_MS = 7000
const MAX_IMAGE_ATTACHMENTS = 16

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value)
  const digest = await window.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function fileToAttachment(file: File): Promise<RuntimeAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = async () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      resolve({
        id: `attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        type: 'image',
        name: file.name || '图片',
        mimeType: file.type || 'image/png',
        size: file.size,
        localUrl: URL.createObjectURL(file),
        dataUrl,
        sha256: dataUrl ? await sha256Hex(dataUrl) : undefined,
        createdAt: nowIso(),
      })
    }
    reader.readAsDataURL(file)
  })
}

export function useTaskController({
  authState,
  authToken,
  authUser,
  executionSettings,
  onAfterSelectTask,
  onFocusComposer,
  onPinToBottom,
  setAuthUser,
}: {
  authState: string
  authToken: string
  authUser: AccountUser | null
  executionSettings: ExecutionSettings
  onAfterSelectTask: () => void
  onFocusComposer: () => void
  onPinToBottom: () => void
  setAuthUser: Dispatch<SetStateAction<AccountUser | null>>
}) {
  const [tasks, setTasks] = useState<CodexTask[]>([welcomeTask])
  const [activeTaskId, setActiveTaskId] = useState(welcomeTask.id)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('checking')
  const [quotaNotice, setQuotaNotice] = useState('')
  const [attachments, setAttachments] = useState<RuntimeAttachment[]>([])
  const [sseReconnectNonce, setSseReconnectNonce] = useState(0)
  const [watchedTaskIds, setWatchedTaskIds] = useState<string[]>([])
  const workspace = defaultWorkspace

  const activeTask = useMemo(() => {
    if (activeTaskId === welcomeTask.id) return welcomeTask
    return tasks.find((task) => task.id === activeTaskId) ?? tasks[0] ?? welcomeTask
  }, [activeTaskId, tasks])
  const liveTaskIds = useMemo(() => tasks.filter(shouldWatchRuntimeTask).map((task) => task.id).sort().join('|'), [tasks])
  const watchedTaskIdsKey = useMemo(() => watchedTaskIds.slice().sort().join('|'), [watchedTaskIds])
  const visibleTranscript = useMemo(() => activeTask.transcript.filter(shouldShowMessage), [activeTask.transcript])
  const mentionImages = useMemo(() => conversationImages(activeTask), [activeTask])
  const isWelcome = activeTask.id === 'welcome'
  const isBusy = isLiveTask(activeTask)
  const busyElapsed = useBusyElapsed(activeTask, isBusy)
  const { prompt, setPrompt } = useTaskDrafts(activeTask.id)
  const latestVisibleItem = visibleTranscript.at(-1)
  const shouldShowThinking = isBusy && latestVisibleItem?.role !== 'assistant'
  const remainingTokens = authUser ? authUser.tokenBudget - authUser.tokenUsed : 0
  const quotaDepleted = remainingTokens <= 0
  const placeholder = quotaDepleted ? 'Token 额度不足，可先充值或联系管理员' : isBusy ? '当前任务运行中，完成后继续发送' : '让墨渊做点什么...'
  const canSubmit = !isSubmitting && !isBusy && !quotaDepleted && (Boolean(prompt.trim()) || attachments.length > 0)
  const showStatusBadge = !isWelcome && (activeTask.status !== 'completed' || runtimeState === 'offline')

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

  function regenerateResource(resourcePrompt: string) {
    if (!resourcePrompt.trim()) return
    setPrompt(`重新生成：${resourcePrompt.trim()}`)
    window.requestAnimationFrame(onFocusComposer)
  }

  async function addImageAttachments(files: File[]) {
    const images = files.filter((file) => file.type.startsWith('image/')).slice(0, Math.max(0, MAX_IMAGE_ATTACHMENTS - attachments.length))
    if (!images.length) {
      if (attachments.length >= MAX_IMAGE_ATTACHMENTS) {
        setQuotaNotice(`一次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`)
        window.setTimeout(() => setQuotaNotice(''), 2400)
      }
      return
    }
    try {
      const next = await Promise.all(images.map(fileToAttachment))
      setAttachments((current) => [...current, ...next].slice(0, MAX_IMAGE_ATTACHMENTS))
    } catch (error) {
      logClientEvent('attachments.image_read_failed', errorLogDetails(error), 'warn')
      setQuotaNotice('图片读取失败，请重新选择。')
      window.setTimeout(() => setQuotaNotice(''), 2400)
    }
  }

  function removeAttachment(id: string) {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id)
      if (target?.localUrl?.startsWith('blob:')) URL.revokeObjectURL(target.localUrl)
      return current.filter((attachment) => attachment.id !== id)
    })
  }

  function attachConversationImage(image: ConversationImage) {
    const dedupeKey = image.dataUrl ?? image.url
    let added = false
    setAttachments((current) => {
      if (current.length >= MAX_IMAGE_ATTACHMENTS) return current
      const exists = current.some((attachment) => (attachment.storageUrl ?? attachment.dataUrl ?? attachment.localUrl) === dedupeKey)
      if (exists) return current
      added = true
      return [
        ...current,
        {
          id: `mention-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: 'image',
          name: image.name,
          mimeType: image.mimeType ?? 'image/png',
          size: image.size ?? 0,
          dataUrl: image.dataUrl,
          storageUrl: image.dataUrl ? undefined : image.url,
          localUrl: image.dataUrl ? undefined : image.url,
          sha256: image.sha256,
          createdAt: nowIso(),
        },
      ]
    })
    if (!added && attachments.length >= MAX_IMAGE_ATTACHMENTS) {
      setQuotaNotice(`一次最多添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`)
      window.setTimeout(() => setQuotaNotice(''), 2400)
    }
  }

  function resetTasks() {
    logClientEvent('task.reset')
    setQuotaNotice('')
    setTasks([welcomeTask])
    setActiveTaskId(welcomeTask.id)
  }

  const handleRuntimeTasksLoaded = useCallback((loadedTasks: CodexTask[]) => {
    if (!loadedTasks.length) return
    const nextTasks = loadedTasks
      .filter((task) => !isAuxiliaryTask(task))
      .map(normalizeTask)
      .sort((a, b) => taskSortValue(b) - taskSortValue(a))
    setTasks(nextTasks)
    setActiveTaskId((current) => (current === welcomeTask.id ? nextTasks[0]?.id ?? current : current))
  }, [])

  const handleRuntimeLoadFailed = useCallback(() => {
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
  }, [])

  const handleTaskSnapshot = useCallback((task: CodexTask) => {
    setTasks((current) => mergeTask(current, task))
  }, [])

  const handleUnwatchTask = useCallback((taskId: string) => {
    setWatchedTaskIds((current) => current.filter((id) => id !== taskId))
  }, [])

  const handleTaskMissing = useCallback((taskId: string) => {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId && isLiveTask(task)
          ? {
              ...task,
              status: 'interrupted',
              updatedAt: nowIso(),
              transcript: [
                ...task.transcript,
                {
                  role: 'system',
                  content: '本地 Runtime 已重启，这个任务状态已丢失。可以在当前对话里重新发送。',
                  timestamp: nowIso(),
                },
              ],
            }
          : task,
      ),
    )
  }, [])

  const handleTaskEvent = useCallback((event: CodexTaskEvent) => {
    setTasks((current) => current.map((task) => (task.id === event.taskId ? mergeEventIntoTask(task, event) : task)))
  }, [])

  const reconnectTaskEvents = useCallback(() => {
    setSseReconnectNonce((value) => value + 1)
  }, [])

  useRuntimeBootstrap({
    authState,
    onLoadFailed: handleRuntimeLoadFailed,
    onRuntimeState: setRuntimeState,
    onTasksLoaded: handleRuntimeTasksLoaded,
  })

  useEffect(() => {
    if (authState !== 'signed-in' || !liveTaskIds) return
    const ids = liveTaskIds.split('|').filter(Boolean)
    setWatchedTaskIds((current) => Array.from(new Set([...current, ...ids])).sort())
  }, [authState, liveTaskIds])

  useLiveTaskPolling({
    authState,
    onRuntimeState: setRuntimeState,
    onTaskMissing: handleTaskMissing,
    onTaskSnapshot: handleTaskSnapshot,
    onUnwatchTask: handleUnwatchTask,
    watchedTaskIdsKey,
  })

  useTaskEventStream({
    activeTask,
    enabled: shouldWatchRuntimeTask(activeTask),
    onEvent: handleTaskEvent,
    onReconnect: reconnectTaskEvents,
    onRuntimeState: setRuntimeState,
    reconnectNonce: sseReconnectNonce,
  })

  async function stopActiveTask() {
    if (!isBusy || isCancelling || activeTask.id === 'welcome') return

    logClientEvent('task.stop.start', taskLogSummary(activeTask), 'warn')
    setIsCancelling(true)
    try {
      const stoppedTask = await cancelRuntimeTask(activeTask.id)
      logClientEvent('task.stop.success', taskLogSummary(stoppedTask))
      setRuntimeState('online')
      setTasks((current) => mergeTask(current, stoppedTask))
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

  async function submitPluginRequest(requestId: string, values: Record<string, unknown>) {
    if (activeTask.id === 'welcome' || !authToken) return
    logClientEvent('plugin_request.submit.start', { requestId, task: taskLogSummary(activeTask) })
    try {
      const updatedTask = await submitRuntimePluginInput({
        enterpriseApiBase,
        enterpriseAuthToken: authToken,
        requestId,
        taskId: activeTask.id,
        values,
      })
      logClientEvent('plugin_request.submit.success', { requestId, task: taskLogSummary(updatedTask) })
      setRuntimeState('online')
      setWatchedTaskIds((current) => Array.from(new Set([...current, updatedTask.id])).sort())
      setTasks((current) => mergeTask(current, updatedTask))
    } catch (error) {
      logClientEvent('plugin_request.submit.failed', errorLogDetails(error, { requestId, task: taskLogSummary(activeTask) }), 'error')
      const message = error instanceof Error ? error.message : '插件表单提交失败'
      setTasks((current) =>
        current.map((task) =>
          task.id === activeTask.id
            ? {
                ...task,
                transcript: [
                  ...task.transcript,
                  { role: 'system', content: `插件表单提交失败：${message}`, timestamp: nowIso() },
                ],
              }
            : task,
        ),
      )
    } finally {
      window.requestAnimationFrame(onFocusComposer)
    }
  }

  async function deferPluginRequest(requestId: string) {
    if (activeTask.id === 'welcome') return
    logClientEvent('plugin_request.defer.start', { requestId, task: taskLogSummary(activeTask) })
    try {
      const updatedTask = await deferRuntimePluginInput(activeTask.id, requestId)
      logClientEvent('plugin_request.defer.success', { requestId, task: taskLogSummary(updatedTask) })
      setRuntimeState('online')
      setTasks((current) => mergeTask(current, updatedTask))
    } catch (error) {
      logClientEvent('plugin_request.defer.failed', errorLogDetails(error, { requestId, task: taskLogSummary(activeTask) }), 'error')
      const message = error instanceof Error ? error.message : '稍后处理失败'
      setTasks((current) =>
        current.map((task) =>
          task.id === activeTask.id
            ? {
                ...task,
                transcript: [
                  ...task.transcript,
                  { role: 'system', content: `稍后处理失败：${message}`, timestamp: nowIso() },
                ],
              }
            : task,
        ),
      )
    } finally {
      window.requestAnimationFrame(onFocusComposer)
    }
  }

  async function submitTask() {
    const promptText = prompt.trim()
    const draftAttachments = attachments
    const taskAttachments = draftAttachments.map(attachmentForPersistence)
    const workspacePath = workspace.trim() || defaultWorkspace
    if ((!promptText && !taskAttachments.length) || isSubmitting || isBusy || !authToken) return
    if (quotaDepleted) {
      logClientEvent('task.submit.quota_depleted', { remainingTokens })
      setQuotaNotice('当前没有可用 Token，等待管理员在后台派发额度。')
      window.setTimeout(() => setQuotaNotice(''), 3600)
      return
    }

    let currentUser = authUser
    logClientEvent('task.submit.preflight', {
      activeTask: taskLogSummary(activeTask),
      executionSettings,
      attachmentCount: taskAttachments.length,
      promptLength: promptText.length,
      workspace: workspacePath,
    })
    onPinToBottom()
    const shouldResume = activeTask.id !== 'welcome' && canResumeTask(activeTask)
    const pendingTask = shouldResume ? appendPendingTurn(activeTask, promptText, workspacePath, taskAttachments) : buildPendingTask(promptText, workspacePath, taskAttachments)
    setIsSubmitting(true)
    setTasks((current) => mergeTask(current, pendingTask))
    setActiveTaskId(pendingTask.id)
    setPrompt('')
    setAttachments([])
    draftAttachments.forEach(revokeAttachmentPreview)

    const failPendingTask = (message: string) => {
      const failedTask: CodexTask = {
        ...pendingTask,
        status: 'failed',
        updatedAt: nowIso(),
        transcript: [
          ...pendingTask.transcript,
          {
            role: 'system',
            content: message,
            timestamp: nowIso(),
          },
        ],
      }
      setTasks((current) => (shouldResume ? mergeTask(current, failedTask) : replaceTask(current, pendingTask.id, failedTask)))
      setActiveTaskId(failedTask.id)
    }

    if (currentUser) {
      void loadSignedInUser(authToken, { timeoutMs: SUBMIT_AUTH_REFRESH_TIMEOUT_MS })
        .then((freshUser) => {
          setAuthUser(freshUser)
          if (freshUser.tokenBudget - freshUser.tokenUsed <= 0) {
            logClientEvent('task.submit.quota_depleted_after_background_refresh', { tokenBudget: freshUser.tokenBudget, tokenUsed: freshUser.tokenUsed }, 'warn')
            setQuotaNotice('当前没有可用 Token，等待管理员在后台派发额度。')
            window.setTimeout(() => setQuotaNotice(''), 3600)
          }
        })
        .catch((error) => {
          logClientEvent('task.submit.preflight_refresh_slow', errorLogDetails(error, { runtimeState }), 'warn')
        })
    } else {
      try {
        const freshUser = await loadSignedInUser(authToken, { timeoutMs: SUBMIT_AUTH_REQUIRED_TIMEOUT_MS })
        currentUser = freshUser
        setAuthUser(freshUser)
        if (freshUser.tokenBudget - freshUser.tokenUsed <= 0) {
          logClientEvent('task.submit.quota_depleted_after_refresh', { tokenBudget: freshUser.tokenBudget, tokenUsed: freshUser.tokenUsed }, 'warn')
          setQuotaNotice('当前没有可用 Token，等待管理员在后台派发额度。')
          window.setTimeout(() => setQuotaNotice(''), 3600)
          failPendingTask('当前没有可用 Token，等待管理员在后台派发额度。')
          setIsSubmitting(false)
          return
        }
      } catch (error) {
        logClientEvent('task.submit.preflight_failed', errorLogDetails(error, { runtimeState }), 'warn')
        setRuntimeState('offline')
        failPendingTask(`发送前校验失败：${error instanceof Error ? error.message : '请检查后台连接'}`)
        setIsSubmitting(false)
        return
      }
    }

    if (currentUser.tokenBudget - currentUser.tokenUsed <= 0) {
      logClientEvent('task.submit.quota_depleted_from_cached_user', { tokenBudget: currentUser.tokenBudget, tokenUsed: currentUser.tokenUsed }, 'warn')
      setQuotaNotice('当前没有可用 Token，等待管理员在后台派发额度。')
      window.setTimeout(() => setQuotaNotice(''), 3600)
      failPendingTask('当前没有可用 Token，等待管理员在后台派发额度。')
      setIsSubmitting(false)
      return
    }

    logClientEvent('task.submit.local_pending', {
      shouldResume,
      sourceTask: taskLogSummary(activeTask),
      workspace: workspacePath,
    })

    try {
      const runtimeTask = await createRuntimeTask({
        employeeId: currentUser?.id ?? localEmployeeId,
        enterpriseApiBase,
        enterpriseAuthToken: authToken,
        reasoningEffort: executionSettings.reasoningEffort,
        sandboxMode: executionSettings.sandboxMode,
        workspace: workspacePath,
        prompt: promptText,
        attachments: taskAttachments,
        parentTaskId: shouldResume ? activeTask.id : undefined,
        sessionId: shouldResume ? activeTask.sessionId : undefined,
      })
      logClientEvent('task.submit.accepted', {
        pendingTaskId: pendingTask.id,
        shouldResume,
        task: taskLogSummary(runtimeTask),
      })
      setRuntimeState('online')
      if (isLiveTask(runtimeTask)) {
        setWatchedTaskIds((current) => Array.from(new Set([...current, runtimeTask.id])).sort())
      }
      setTasks((current) => (shouldResume ? mergeTask(current, runtimeTask) : replaceTask(current, pendingTask.id, runtimeTask)))
      setActiveTaskId(runtimeTask.id)
    } catch (error) {
      logClientEvent('task.submit.failed', errorLogDetails(error, {
        pendingTaskId: pendingTask.id,
        shouldResume,
        sourceTask: taskLogSummary(activeTask),
      }), 'error')
      void uploadDiagnosticsSnapshot('task-submit-failed')
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
    attachments,
    addImageAttachments,
    attachConversationImage,
    busyElapsed,
    canSubmit,
    isBusy,
    isCancelling,
    isSubmitting,
    isWelcome,
    mentionImages,
    placeholder,
    prompt,
    quotaDepleted,
    quotaNotice,
    regenerateResource,
    resetTasks,
    runtimeState,
    selectTask,
    setPrompt,
    removeAttachment,
    shouldShowThinking,
    showStatusBadge,
    startNewConversation,
    stopActiveTask,
    deferPluginRequest,
    submitPluginRequest,
    submitTask,
    tasks,
    visibleTranscript,
  }
}
