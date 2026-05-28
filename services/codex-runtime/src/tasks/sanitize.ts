import {
  compactAssistantTranscript,
  friendlyRuntimeMessage,
  isRuntimeFailureNotice,
  runtimeFailureDiagnostic,
  type CodexTask,
} from '@eaw/shared'
import { isMoyuanToolCallContent } from '../skills/contracts.js'

function isInternalCodexJson(content: string) {
  const text = content.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return false

  try {
    const payload = JSON.parse(text) as { type?: unknown; item?: { type?: unknown } }
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
    return text.includes('"type":"item.') || text.includes('"type":"web_search"')
  }
}

function isMutedTranscriptStatus(content: string) {
  const text = content.trim()
  return (
    /^正在生成图片[.。…]*$/.test(text) ||
    text.startsWith('当前已接入静态图片生成，还没有接入视频或动图生成') ||
    text === '正在调用视频生成技能...' ||
    text === '视频任务已创建，正在生成...' ||
    text === '视频仍在生成中' ||
    text.startsWith('当前状态：')
  )
}

function compactTranscript(items: CodexTask['transcript']) {
  return compactAssistantTranscript(items)
}

function isRawRuntimeFailure(content: string, role?: CodexTask['transcript'][number]['role']) {
  if (role === 'assistant') return false
  const text = content.trim()
  return (
    /^Codex\s*任务退出，代码/.test(text) ||
    text.startsWith('Missing environment variable:') ||
    text.includes('unexpected status 403 Forbidden: invalid api key') ||
    text.includes('invalid api key') ||
    text.startsWith('Codex app-server') ||
    isRuntimeFailureNotice(text)
  )
}

function latestTurnItems(task: CodexTask) {
  const lastUserIndex = task.transcript.map((item) => item.role).lastIndexOf('user')
  return lastUserIndex >= 0 ? task.transcript.slice(lastUserIndex) : task.transcript
}

function latestTurnCompletedWithoutAssistant(task: CodexTask) {
  if (task.status !== 'completed') return false
  const turn = latestTurnItems(task)
  const hasUser = turn.some((item) => item.role === 'user')
  const lastToolIndex = turn.map((item) => item.role).lastIndexOf('tool')
  const assistantAfterLastTool = turn.some((item, index) => {
    if (lastToolIndex >= 0 && index <= lastToolIndex) return false
    return item.role === 'assistant' && item.content.trim() && !isRuntimeFailureNotice(item.content)
  })
  const hasAssistant = turn.some((item) => item.role === 'assistant' && item.content.trim() && !isRuntimeFailureNotice(item.content))
  const hasCompleted = turn.some((item) => item.content === '任务完成' || item.content === 'Codex 任务已完成')
  if (!hasUser || !hasCompleted) return false
  if (lastToolIndex >= 0) return !assistantAfterLastTool
  return !hasAssistant
}

export function sanitizeTask(task: CodexTask): CodexTask {
  const hasRuntimeFailure = task.transcript.some((item) => isRawRuntimeFailure(item.content, item.role))
  const hasEmptyCompletion = latestTurnCompletedWithoutAssistant(task)
  const transcript = compactTranscript(
    task.transcript
      .filter((item) => {
        const content = item.content.trim()
        return (
          content &&
          !isInternalCodexJson(content) &&
          !isMoyuanToolCallContent(content) &&
          !isMutedTranscriptStatus(content) &&
          !isRawRuntimeFailure(content, item.role)
        )
      })
      .map((item) => (item.role === 'system' ? { ...item, content: friendlyRuntimeMessage(item.content) } : item)),
  )

  if ((task.status === 'failed' || hasEmptyCompletion) && hasEmptyCompletion && !transcript.some((item) => item.content.startsWith('失败诊断：'))) {
    transcript.push({
      role: 'system',
      content: '失败诊断：Codex 已结束本轮工具执行，但没有返回最终回复。任务已停止，可以重新发送；如果连续出现，需要检查 app-server 的 turn.completed 与 assistant message 事件。',
      timestamp: task.updatedAt ?? transcript.at(-1)?.timestamp ?? new Date().toISOString(),
    })
  } else if (task.status === 'failed' && hasRuntimeFailure && !transcript.some((item) => item.content.startsWith('失败诊断：'))) {
    transcript.push({
      role: 'system',
      content: runtimeFailureDiagnostic(task.transcript),
      timestamp: task.updatedAt ?? transcript.at(-1)?.timestamp ?? new Date().toISOString(),
    })
  } else if (task.status === 'failed' && transcript.length === 1 && transcript[0]?.role === 'user') {
    transcript.push({
      role: 'system',
      content: runtimeFailureDiagnostic(task.transcript),
      timestamp: task.updatedAt ?? transcript[0].timestamp,
    })
  }

  return {
    ...task,
    status: hasEmptyCompletion ? 'failed' : task.status,
    transcript,
  }
}
