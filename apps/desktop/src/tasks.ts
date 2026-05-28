import type { CodexTask, CodexTaskEvent } from '@eaw/shared'

export type TranscriptItem = CodexTask['transcript'][number]

export function nowIso() {
  return new Date().toISOString()
}

export function statusText(status: CodexTask['status']) {
  return {
    queued: '排队',
    running: '运行中',
    needs_approval: '待确认',
    completed: '完成',
    failed: '失败',
  }[status]
}

export function taskSortValue(task: CodexTask) {
  return new Date(task.createdAt ?? task.transcript[0]?.timestamp ?? 0).getTime()
}

export function normalizeTask(task: CodexTask): CodexTask {
  const normalizedTask = ensureTranscriptModel(task)
  const rawTranscript = normalizedTask.transcript ?? []
  const inferredFailed = latestTurnHasFailure(rawTranscript) || latestTurnCompletedWithoutAssistant(task.status, rawTranscript)
  const status = inferredFailed ? 'failed' : task.status
  const transcript = compactTranscript(filterDisplayTranscript(rawTranscript))
  const title = task.title?.trim().replace(/^生成图片[:：]\s*/, '')
  const hasVisibleReply = transcript.some((item) => item.role !== 'user')
  const hasFailureDiagnostic = transcript.some((item) => item.content.startsWith('失败诊断：'))

  if (status === 'failed' && !hasFailureDiagnostic && latestTurnCompletedWithoutAssistant(task.status, rawTranscript)) {
    transcript.push({
      role: 'system',
      content: '失败诊断：Codex 已结束本轮工具执行，但没有返回最终回复。任务已停止，可以重新发送；如果连续出现，需要检查 app-server 的 turn.completed 与 assistant message 事件。',
      timestamp: task.updatedAt ?? nowIso(),
    })
  } else if (status === 'failed' && !hasFailureDiagnostic && latestTurnHasRuntimeFailure(rawTranscript)) {
    transcript.push({
      role: 'system',
      content: failureSummary(rawTranscript),
      timestamp: task.updatedAt ?? nowIso(),
    })
  } else if (status === 'failed' && !hasVisibleReply) {
    transcript.push({
      role: 'system',
      content: failureSummary(rawTranscript),
      timestamp: task.updatedAt ?? nowIso(),
    })
  }

  return {
    ...normalizedTask,
    status,
    title: title || transcript.find((item) => item.role === 'user')?.content.slice(0, 36) || '新任务',
    transcript,
  }
}

function filterDisplayTranscript(items: TranscriptItem[]) {
  const visible = items.filter(shouldShowMessage)
  const latestDiagnosticIndex = visible.findLastIndex((item) => item.content.startsWith('失败诊断：'))
  if (latestDiagnosticIndex < 0) return visible

  const diagnosticTurnId = visible[latestDiagnosticIndex]?.turnId
  return visible.filter((item, index) => {
    if (index === latestDiagnosticIndex) return true
    if (item.turnId !== diagnosticTurnId) return true
    return !isRawSkillFailureNotice(item.content)
  })
}

function isRawSkillFailureNotice(content: string) {
  return /^(图片|视频|技能).{0,8}失败[:：]/.test(content.trim())
}

function ensureTranscriptModel(task: CodexTask): CodexTask {
  let turnIndex = 0
  let currentTurnId = `${task.id}-turn-1`
  const transcript = (task.transcript ?? []).map((item, index) => {
    if (item.role === 'user') {
      turnIndex += 1
      currentTurnId = item.turnId ?? `${task.id}-turn-${turnIndex}`
    } else if (turnIndex === 0) {
      turnIndex = 1
      currentTurnId = item.turnId ?? `${task.id}-turn-1`
    }

    return {
      ...item,
      seq: typeof item.seq === 'number' ? item.seq : index + 1,
      turnId: item.turnId ?? currentTurnId,
    }
  })

  return { ...task, transcript }
}

export function compactTranscript(items: TranscriptItem[]) {
  return items.reduce<TranscriptItem[]>((merged, item) => {
    const previous = merged.at(-1)
    if (previous?.role === 'assistant' && item.role === 'assistant') {
      if (previous.itemId && item.itemId && previous.itemId === item.itemId) {
        merged[merged.length - 1] = {
          ...item,
          content: mergeAssistantContent(previous.content, item.content),
        }
        return merged
      }
      if (item.content.startsWith(previous.content)) {
        merged[merged.length - 1] = { ...item, content: mergeAssistantContent(previous.content, item.content) }
        return merged
      }
      if (previous.content.startsWith(item.content)) return merged
    }
    if (previous?.role === 'user' && item.role === 'user' && previous.content === item.content) return merged
    merged.push(item)
    return merged
  }, [])
}

function sharedPrefixSuffixLength(left: string, right: string) {
  const maxLength = Math.min(left.length, right.length)
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length
  }
  return 0
}

export function mergeAssistantContent(current: string, incoming: string) {
  if (!current) return incoming
  if (!incoming) return current
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  const overlap = sharedPrefixSuffixLength(current, incoming)
  return `${current}${incoming.slice(overlap)}`
}

function finalAssistantContent(current: string, incoming: string) {
  if (!current) return incoming
  if (!incoming) return current
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  const sameOpening = current.slice(0, 8) === incoming.slice(0, 8)
  const similarLength = incoming.length >= current.length * 0.6
  if (sameOpening && similarLength) return incoming

  return mergeAssistantContent(current, incoming)
}

function eventToTranscript(event: CodexTaskEvent) {
  return {
    role: event.role,
    content: event.content,
    eventId: event.id,
    itemId: event.itemId,
    seq: event.seq,
    timestamp: event.timestamp,
    turnId: event.turnId,
  }
}

export function mergeTask(tasks: CodexTask[], next: CodexTask) {
  const normalized = normalizeTask(next)
  const withoutWelcome = tasks.filter((task) => task.id !== 'welcome')
  const existing = withoutWelcome.find((task) => task.id === normalized.id)
  const reconciled = existing ? reconcileTaskSnapshot(existing, normalized) : normalized
  const exists = Boolean(existing)
  const merged = exists
    ? withoutWelcome.map((task) => (task.id === reconciled.id ? reconciled : task))
    : [reconciled, ...withoutWelcome]

  return merged.sort((a, b) => taskSortValue(b) - taskSortValue(a))
}

function reconcileTaskSnapshot(local: CodexTask, incoming: CodexTask): CodexTask {
  const isLive = local.status === 'queued' || local.status === 'running' || incoming.status === 'queued' || incoming.status === 'running'
  if (!isLive) return incoming

  const transcript = compactTranscript(mergeTranscriptSnapshots(local.transcript, incoming.transcript))
  return { ...incoming, transcript }
}

function mergeTranscriptSnapshots(local: TranscriptItem[], incoming: TranscriptItem[]) {
  const merged = incoming.map((item) => ({ ...item }))

  local.forEach((localItem) => {
    const stableIndex = merged.findIndex((item) => transcriptIdentity(item) === transcriptIdentity(localItem))
    if (stableIndex >= 0) {
      if (localItem.role === 'assistant') {
        const remoteItem = merged[stableIndex]
        merged[stableIndex] = {
          ...remoteItem,
          content: mergeAssistantContent(localItem.content, remoteItem.content),
        }
      }
      return
    }

    if (localItem.role !== 'assistant') {
      merged.push(localItem)
      return
    }

    const sameIdIndex = localItem.itemId ? merged.findIndex((item) => item.itemId === localItem.itemId && item.role === 'assistant') : -1
    if (sameIdIndex >= 0) {
      const remoteItem = merged[sameIdIndex]
      merged[sameIdIndex] = {
        ...remoteItem,
        content: mergeAssistantContent(localItem.content, remoteItem.content),
      }
      return
    }

    if (!merged.some((item) => item.role === localItem.role && item.content === localItem.content && item.timestamp === localItem.timestamp)) {
      merged.push(localItem)
    }
  })

  return merged.sort(compareTranscriptItems)
}

function transcriptIdentity(item: TranscriptItem) {
  if (item.eventId) return `event:${item.eventId}`
  if (item.itemId && item.role === 'assistant') return `assistant:${item.turnId ?? ''}:${item.itemId}`
  return `${item.role}:${item.turnId ?? ''}:${item.seq ?? item.timestamp}:${item.content.slice(0, 120)}`
}

function compareTranscriptItems(left: TranscriptItem, right: TranscriptItem) {
  const leftSeq = typeof left.seq === 'number' ? left.seq : Number.POSITIVE_INFINITY
  const rightSeq = typeof right.seq === 'number' ? right.seq : Number.POSITIVE_INFINITY
  if (leftSeq !== rightSeq) return leftSeq - rightSeq
  return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
}

export function replaceTask(tasks: CodexTask[], oldTaskId: string, next: CodexTask) {
  return mergeTask(
    tasks.filter((task) => task.id !== oldTaskId),
    next,
  )
}

export function shouldShowMessage(item: TranscriptItem) {
  const content = item.content.trim()
  if (!content) return false
  if (content.startsWith('失败诊断：')) return true
  if (item.role === 'tool') return true
  if (/^正在生成图片[.。…]*$/.test(content)) return false
  if (isTransientSkillStatus(content)) return false
  if (item.role !== 'assistant' && isRuntimeFailureNotice(content)) return false
  if (/^Codex\s*任务退出，代码/.test(content)) return false
  if (/Missing environment variable:|invalid api key|403 Forbidden/i.test(content)) return false
  if (isInternalCodexJson(content)) return false
  if (item.role !== 'system') return true
  return (
    content.includes('Codex Runtime 没连上') ||
    content.includes('任务创建失败') ||
    content.includes('发送失败') ||
    content.includes('停止') ||
    content.includes('响应') ||
    content.includes('中断') ||
    content.includes('退出') ||
    content.includes('失败') ||
    content.includes('错误') ||
    content.includes('未配置') ||
    content.includes('超时') ||
    content.includes('不支持') ||
    content.includes('不可用') ||
    content.includes('密钥') ||
    content.includes('error')
  )
}

function isRuntimeFailureNotice(content: string) {
  const text = content.trim()
  const codexRuntimeFailure =
    /(Codex app-server|Codex Runtime).*(退出|断开|失败|错误|超时|没有返回|没有正常|未启动|没连上|请求超时)/i.test(text) ||
    /(退出|断开|失败|错误|超时|没有返回|没有正常|未启动|没连上|请求超时).*(Codex app-server|Codex Runtime)/i.test(text)

  return (
    text.startsWith('失败诊断：') ||
    text.includes('本轮执行连接中断') ||
    text.includes('本地 Codex 内核暂时没有启动成功') ||
    text.includes('模型响应超时') ||
    text.includes('模型服务暂时不可用') ||
    codexRuntimeFailure ||
    /ECONNREFUSED|OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|timed out|timeout/i.test(text)
  )
}

function redactedEvidence(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/Authorization:\s*[^\n]+/gi, 'Authorization: ***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function failureEvidence(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const matched =
    lines.find((line) => /OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|50[024]|timeout|timed out|超时|Codex app-server|ECONNREFUSED|模型服务|技能代理|内核/i.test(line)) ??
    lines.at(-1) ??
    ''
  return redactedEvidence(matched)
}

function failureSummary(items: TranscriptItem[]) {
  const latestTurn = latestTurnItems(items)
  const text = latestTurn.map((item) => item.content).join('\n')
  const evidence = failureEvidence(text)
  const suffix = evidence ? ` 原始线索：${evidence}` : ''
  if (/OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|模型服务暂时不可用/i.test(text)) {
    return `失败诊断：模型通道鉴权失败。后台模型 KEY、Base URL 或默认模型可能不匹配，本轮已停止；请检查后台模型配置后重试。${suffix}`
  }
  if (/not activated the model|has not activated the model|activate the model service/i.test(text)) {
    return `失败诊断：视频模型尚未开通。火山方舟当前模型还没有激活，本轮已停止；请在 Ark 控制台开通后重试。${suffix}`
  }
  if (/timeout|timed out|超时|模型响应超时/i.test(text)) {
    const hasLargeScan = /node_modules|dist|release|\.git|package-lock|find .*maxdepth|find .*type f|cat .*index\.|grep -n/i.test(text)
    if (hasLargeScan) {
      return `失败诊断：模型响应超时。本轮包含较大的项目扫描或命令输出，可能把上下文撑得过大；任务已停止，可以缩小扫描范围或新建对话重试。${suffix}`
    }
    return `失败诊断：模型响应超时。本轮已停止，可能是模型通道响应慢、上下文过大，或 app-server 没有正常返回。${suffix}`
  }
  if (/Codex app-server|Codex Runtime|ECONNREFUSED|本地 Codex 内核暂时没有启动成功/i.test(text)) {
    return `失败诊断：本地 Codex 执行连接中断。子进程或 app-server 没有正常收口，本轮已停止，可以重新发送。${suffix}`
  }
  return `失败诊断：本轮执行中断。任务状态已经收口为失败，可以重新发送；如果连续出现，需要看 Runtime 日志定位。${suffix}`
}

function latestTurnItems(items: TranscriptItem[]) {
  const lastUserIndex = items.map((item) => item.role).lastIndexOf('user')
  return lastUserIndex >= 0 ? items.slice(lastUserIndex) : items
}

function latestTurnHasRuntimeFailure(items: TranscriptItem[]) {
  return latestTurnItems(items).some(isStructuredFailureItem)
}

function latestTurnCompletedWithoutAssistant(status: CodexTask['status'], items: TranscriptItem[]) {
  if (status !== 'completed') return false
  const turn = latestTurnItems(items)
  const hasUser = turn.some((item) => item.role === 'user')
  const lastToolIndex = turn.map((item) => item.role).lastIndexOf('tool')
  const assistantAfterLastTool = turn.some((item, index) => {
    if (lastToolIndex >= 0 && index <= lastToolIndex) return false
    return item.role === 'assistant' && !isRuntimeFailureNotice(item.content) && !item.content.startsWith('失败诊断：')
  })
  const hasAssistant = turn.some((item) => item.role === 'assistant' && !isRuntimeFailureNotice(item.content) && !item.content.startsWith('失败诊断：'))
  const hasCompleted = turn.some((item) => item.content === '任务完成' || item.content === 'Codex 任务已完成')
  if (!hasUser || !hasCompleted) return false
  if (lastToolIndex >= 0) return !assistantAfterLastTool
  return !hasAssistant
}

export function latestTurnHasFailure(items: TranscriptItem[]) {
  return latestTurnItems(items).some(isStructuredFailureItem)
}

function isStructuredFailureItem(item: TranscriptItem) {
  if (item.role !== 'system') return false
  const content = item.content.trim()
  return content.startsWith('失败诊断：') || /^Codex\s*任务退出，代码/.test(content) || isRuntimeFailureNotice(content)
}

function isTransientSkillStatus(content: string) {
  return (
    content === '正在调用视频生成技能...' ||
    content === '视频任务已创建，正在生成...' ||
    content === '视频仍在生成中' ||
    content.startsWith('当前状态：')
  )
}

function isInternalCodexJson(content: string) {
  if (!content.startsWith('{') || !content.endsWith('}')) return false

  try {
    const payload = JSON.parse(content) as { moyuan_tool?: unknown; type?: unknown; item?: { type?: unknown } }
    if (payload.moyuan_tool === 'image_generation' || payload.moyuan_tool === 'video_generation') return true
    const type = typeof payload.type === 'string' ? payload.type : ''
    const itemType = payload.item && typeof payload.item.type === 'string' ? payload.item.type : ''

    return (
      type.startsWith('item.') ||
      type.startsWith('turn.') ||
      type.includes('delta') ||
      itemType === 'web_search' ||
      itemType === 'reasoning' ||
      itemType === 'command_execution'
    )
  } catch {
    return content.includes('"type":"item.') || content.includes('"type":"web_search"')
  }
}

export function messageLabel(role: TranscriptItem['role']) {
  return {
    assistant: '墨渊',
    tool: '命令',
    system: '系统',
    user: '你',
  }[role]
}

export function taskMeta(task: CodexTask) {
  const assistantTurns = task.transcript.filter((item) => item.role === 'assistant').length
  const commandTurns = task.transcript.filter((item) => item.role === 'tool' && item.content.trim().startsWith('$')).length
  if (task.generatedImages?.length) return `${task.generatedImages.length} 张图片`
  if (task.generatedVideos?.length) return `${task.generatedVideos.length} 个视频`
  if (task.sessionId) return `${assistantTurns} 轮 · 可续聊`
  if (commandTurns) return `${commandTurns} 次命令`
  return statusText(task.status)
}

function eventIndicatesFailure(event: CodexTaskEvent) {
  const content = event.content.trim()
  return event.type === 'turn.failed' || event.type === 'error' || content.startsWith('失败诊断：') || (event.role !== 'assistant' && isRuntimeFailureNotice(content))
}

function eventStatus(event: CodexTaskEvent, fallback: CodexTask['status']): CodexTask['status'] {
  if (eventIndicatesFailure(event)) return 'failed'
  if (fallback === 'completed' || fallback === 'failed') {
    return fallback
  }
  if (event.type === 'process.exit') return event.content.includes('完成') ? 'completed' : 'failed'
  if (event.type === 'turn.completed') return 'completed'
  if (event.type === 'turn.started' || event.type === 'thread.started' || event.type === 'tool' || event.type === 'message' || event.type === 'message_delta') return 'running'
  return fallback
}

export function mergeEventIntoTask(task: CodexTask, event: CodexTaskEvent): CodexTask {
  const transcriptItem = eventToTranscript(event)
  if (!shouldShowMessage(transcriptItem)) {
    const nextStatus = eventStatus(event, task.status)
    const hasFailureDiagnostic = task.transcript.some((item) => item.content.startsWith('失败诊断：'))
    if (nextStatus === 'failed' && !hasFailureDiagnostic) {
      return {
        ...task,
        status: nextStatus,
        transcript: [
          ...task.transcript,
          {
            role: 'system',
            content: failureSummary([...task.transcript, transcriptItem]),
            timestamp: event.timestamp,
          },
        ],
      }
    }
    return { ...task, status: nextStatus }
  }

  if (event.type === 'message_delta' && event.role === 'assistant') {
    const transcript = [...task.transcript]
    const itemIndex = event.itemId ? transcript.findIndex((item) => item.role === 'assistant' && item.itemId === event.itemId) : -1
    const lastIndex = itemIndex >= 0 ? itemIndex : transcript.length - 1
    const lastItem = transcript[lastIndex]

    const isDifferentAssistantItem = itemIndex < 0 && Boolean(event.itemId && lastItem?.itemId && lastItem.itemId !== event.itemId)
    if (itemIndex < 0 && (lastItem?.role !== 'assistant' || isDifferentAssistantItem)) {
      transcript.push(transcriptItem)
    } else {
      const current = lastItem
      const content = mergeAssistantContent(current.content, event.content)
      transcript[lastIndex] = { ...current, content, itemId: event.itemId ?? current.itemId, timestamp: event.timestamp }
    }
    return { ...task, status: eventStatus(event, task.status), transcript }
  }

  if (event.type === 'message' && event.role === 'assistant' && event.itemId) {
    const existingIndex = task.transcript.findIndex((item) => item.role === 'assistant' && item.itemId === event.itemId)
    if (existingIndex >= 0) {
      const current = task.transcript[existingIndex]
      return {
        ...task,
        status: eventStatus(event, task.status),
        transcript: [
          ...task.transcript.slice(0, existingIndex),
          { ...current, content: finalAssistantContent(current.content, event.content), timestamp: event.timestamp },
          ...task.transcript.slice(existingIndex + 1),
        ],
      }
    }
  }

  if (event.type === 'message' && event.role === 'assistant' && task.transcript.at(-1)?.role === 'assistant') {
    const last = task.transcript.at(-1)
    if (last?.content === event.content || event.content.startsWith(last?.content ?? '')) {
      return {
        ...task,
        status: eventStatus(event, task.status),
        transcript: [...task.transcript.slice(0, -1), { ...transcriptItem, content: finalAssistantContent(last?.content ?? '', event.content), itemId: event.itemId ?? last?.itemId }],
      }
    }
  }

  const seen = task.transcript.some((item) => item.timestamp === event.timestamp && item.content === event.content && item.role === event.role)
  const transcript = seen ? task.transcript : [...task.transcript, transcriptItem]
  return { ...task, status: eventStatus(event, task.status), transcript }
}

export function hasCodexActivity(task: CodexTask) {
  return task.transcript.some((item) => (item.role === 'assistant' || item.role === 'tool') && item.content.trim())
}

export function canResumeTask(task: CodexTask) {
  return task.status === 'completed' && Boolean(task.sessionId) && !latestTurnHasFailure(task.transcript)
}

export function buildPendingTask(promptText: string, workspacePath: string): CodexTask {
  const timestamp = nowIso()
  const taskId = `pending-${Date.now()}`
  return {
    id: taskId,
    title: promptText.slice(0, 36),
    status: 'queued',
    workspace: workspacePath,
    createdAt: timestamp,
    exitCode: null,
    transcript: [
      {
        role: 'user',
        content: promptText,
        seq: 1,
        timestamp,
        turnId: `${taskId}-turn-1`,
      },
    ],
  }
}

export function appendPendingTurn(task: CodexTask, promptText: string, workspacePath: string): CodexTask {
  const normalizedTask = ensureTranscriptModel(task)
  const lastSeq = normalizedTask.transcript.reduce((max, item) => Math.max(max, item.seq ?? 0), 0)
  const nextTurnIndex = normalizedTask.transcript.filter((item) => item.role === 'user').length + 1
  return {
    ...normalizedTask,
    status: 'queued',
    workspace: workspacePath,
    transcript: [
      ...normalizedTask.transcript,
      {
        role: 'user',
        content: promptText,
        seq: lastSeq + 1,
        timestamp: nowIso(),
        turnId: `${normalizedTask.id}-turn-${nextTurnIndex}`,
      },
    ],
  }
}

export function buildLocalErrorTask(error: unknown, workspacePath: string): CodexTask {
  const timestamp = nowIso()
  return {
    id: `error-${Date.now()}`,
    title: '发送失败',
    status: 'failed',
    workspace: workspacePath,
    createdAt: timestamp,
    exitCode: null,
    transcript: [
      {
        role: 'system',
        content: `发送失败：${toUserFacingError(error)}`,
        timestamp,
      },
    ],
  }
}

function toUserFacingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/OPENAI_API_KEY|AI_API_KEY|IMAGE_API_KEY|invalid api key|403 Forbidden|Missing environment variable/i.test(message)) {
    return '模型服务暂时不可用，请检查模型密钥或稍后重试。'
  }
  if (/Failed to fetch|NetworkError|offline|ECONNREFUSED|fetch failed/i.test(message)) {
    return '本地服务暂时没连上，我会继续尝试恢复。'
  }
  if (/Token 额度不足|额度不足|请先登录墨渊账号|登录状态已失效|账号已停用|企业后台暂时不可用/i.test(message)) {
    return message
  }
  return '任务没有正常完成，请稍后再试。'
}
