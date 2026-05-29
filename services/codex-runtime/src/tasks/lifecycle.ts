import type { CodexTask, CodexTaskEvent } from '@eaw/shared'

export type TaskLifecyclePhase = 'queued' | 'starting' | 'running' | 'tool_running' | 'waiting_final' | 'waiting_input' | 'completed' | 'failed' | 'interrupted'

export type TaskLifecycle = {
  phase: TaskLifecyclePhase
  assistantEvents: number
  finalAssistantEvents: number
  lastActivityAt: string
  reason?: string
  startedAt?: string
  toolEvents: number
  turnCompletedAt?: string
}

type LifecycleRecord = {
  cancelRequested?: boolean
  lifecycle?: TaskLifecycle
  task: CodexTask
}

type FailurePredicate = (content: string) => boolean

const terminalPhases = new Set<TaskLifecyclePhase>(['completed', 'failed', 'interrupted'])

function nowIso() {
  return new Date().toISOString()
}

function taskStatusForPhase(phase: TaskLifecyclePhase): CodexTask['status'] {
  if (phase === 'queued') return 'queued'
  if (phase === 'waiting_input') return 'needs_approval'
  if (phase === 'completed') return 'completed'
  if (phase === 'failed') return 'failed'
  if (phase === 'interrupted') return 'interrupted'
  return 'running'
}

function isTerminalPhase(phase: TaskLifecyclePhase) {
  return terminalPhases.has(phase)
}

function latestTurnTranscript(task: CodexTask) {
  const lastUserIndex = task.transcript.map((item) => item.role).lastIndexOf('user')
  return lastUserIndex >= 0 ? task.transcript.slice(lastUserIndex) : task.transcript
}

function inferLifecycleCounters(task: CodexTask, isRuntimeFailure: FailurePredicate) {
  const turn = latestTurnTranscript(task)
  let toolEvents = 0
  let assistantEvents = 0
  let finalAssistantEvents = 0

  for (const item of turn) {
    if (item.role === 'tool') {
      toolEvents += 1
      continue
    }
    if (item.role === 'assistant' && item.content.trim() && !isRuntimeFailure(item.content)) {
      assistantEvents += 1
      if (toolEvents > 0) finalAssistantEvents += 1
    }
  }

  return { assistantEvents, finalAssistantEvents, toolEvents }
}

export function hydrateTaskLifecycle(task: CodexTask, isRuntimeFailure: FailurePredicate): TaskLifecycle {
  const counters = inferLifecycleCounters(task, isRuntimeFailure)
  const lastActivityAt = task.updatedAt ?? task.createdAt ?? nowIso()
  if (task.status === 'failed') return { ...counters, lastActivityAt, phase: 'failed' }
  if (task.status === 'interrupted') return { ...counters, lastActivityAt, phase: 'interrupted' }
  if (task.status === 'completed') return { ...counters, lastActivityAt, phase: 'completed' }
  if (task.status === 'needs_approval') return { ...counters, lastActivityAt, phase: 'waiting_input' }
  if (task.status === 'queued') return { ...counters, lastActivityAt, phase: 'queued' }
  return { ...counters, lastActivityAt, phase: counters.toolEvents > counters.finalAssistantEvents ? 'tool_running' : 'running' }
}

export function resetTaskLifecycleForNewTurn(record: LifecycleRecord, now = nowIso()) {
  record.lifecycle = {
    assistantEvents: 0,
    finalAssistantEvents: 0,
    lastActivityAt: now,
    phase: 'queued',
    toolEvents: 0,
  }
  record.cancelRequested = false
  record.task.exitCode = null
  record.task.status = 'queued'
  record.task.updatedAt = now
  return record.lifecycle
}

export function ensureTaskLifecycle(record: LifecycleRecord, isRuntimeFailure: FailurePredicate) {
  record.lifecycle ??= hydrateTaskLifecycle(record.task, isRuntimeFailure)
  record.task.status = taskStatusForPhase(record.lifecycle.phase)
  return record.lifecycle
}

export function setTaskLifecyclePhase(
  record: LifecycleRecord,
  phase: TaskLifecyclePhase,
  isRuntimeFailure: FailurePredicate,
  reason?: string,
) {
  const lifecycle = ensureTaskLifecycle(record, isRuntimeFailure)
  if (isTerminalPhase(lifecycle.phase) && !isTerminalPhase(phase)) return lifecycle
  lifecycle.phase = phase
  lifecycle.lastActivityAt = nowIso()
  if (phase === 'running' || phase === 'starting' || phase === 'tool_running' || phase === 'waiting_input') lifecycle.startedAt ??= lifecycle.lastActivityAt
  if (phase === 'waiting_final') lifecycle.turnCompletedAt = lifecycle.lastActivityAt
  if (reason) lifecycle.reason = reason
  record.task.status = taskStatusForPhase(phase)
  record.task.updatedAt = lifecycle.lastActivityAt
  return lifecycle
}

export function applyTaskLifecycleEvent(record: LifecycleRecord, event: CodexTaskEvent, isRuntimeFailure: FailurePredicate) {
  const lifecycle = ensureTaskLifecycle(record, isRuntimeFailure)
  lifecycle.lastActivityAt = event.timestamp

  const content = event.content.trim()
  if (event.type === 'turn.interrupted') {
    lifecycle.phase = 'interrupted'
    lifecycle.reason = content || '用户停止任务'
    record.task.status = 'interrupted'
    return lifecycle
  }

  const isFailure = event.type === 'error' || event.type === 'turn.failed' || (event.role === 'system' && isRuntimeFailure(content))
  if (isFailure) {
    lifecycle.phase = 'failed'
    lifecycle.reason = content
    record.task.status = 'failed'
    return lifecycle
  }

  if (isTerminalPhase(lifecycle.phase)) return lifecycle

  if (event.type === 'thread.started' || event.type === 'turn.started') {
    lifecycle.phase = 'running'
    lifecycle.startedAt ??= event.timestamp
  }

  if (event.type === 'plugin.inputRequested' || event.type === 'approval.requested') {
    lifecycle.phase = 'waiting_input'
  }

  if (event.type === 'plugin.inputSubmitted' || event.type === 'approval.resolved') {
    lifecycle.phase = 'running'
  }

  if (event.role === 'tool' && content) {
    lifecycle.toolEvents += 1
    lifecycle.phase = 'tool_running'
  }

  if (event.role === 'assistant' && content && !isRuntimeFailure(content)) {
    lifecycle.assistantEvents += 1
    if (lifecycle.toolEvents > 0) lifecycle.finalAssistantEvents += 1
    lifecycle.phase = 'running'
  }

  if (event.type === 'turn.completed') {
    lifecycle.phase = 'waiting_final'
    lifecycle.turnCompletedAt = event.timestamp
  }

  if (event.type === 'process.exit' && !event.content.includes('完成')) {
    lifecycle.phase = 'failed'
    lifecycle.reason = content
  }

  record.task.status = taskStatusForPhase(lifecycle.phase)
  return lifecycle
}

export function hasFinalAssistantReply(record: LifecycleRecord, isRuntimeFailure: FailurePredicate) {
  const lifecycle = ensureTaskLifecycle(record, isRuntimeFailure)
  if (lifecycle.finalAssistantEvents > 0) return true
  const counters = inferLifecycleCounters(record.task, isRuntimeFailure)
  lifecycle.assistantEvents = Math.max(lifecycle.assistantEvents, counters.assistantEvents)
  lifecycle.finalAssistantEvents = Math.max(lifecycle.finalAssistantEvents, counters.finalAssistantEvents)
  lifecycle.toolEvents = Math.max(lifecycle.toolEvents, counters.toolEvents)
  return lifecycle.finalAssistantEvents > 0 || (lifecycle.toolEvents === 0 && lifecycle.assistantEvents > 0)
}

export function finishTaskLifecycle(record: LifecycleRecord, code: number | null, isRuntimeFailure: FailurePredicate) {
  const lifecycle = ensureTaskLifecycle(record, isRuntimeFailure)
  lifecycle.lastActivityAt = nowIso()
  record.task.exitCode = code

  if (record.cancelRequested) {
    lifecycle.phase = 'interrupted'
    lifecycle.reason = '用户停止任务'
  } else if (lifecycle.phase === 'waiting_input') {
    lifecycle.phase = 'waiting_input'
  } else if (code !== 0 || lifecycle.phase === 'failed') {
    lifecycle.phase = 'failed'
  } else if (hasFinalAssistantReply(record, isRuntimeFailure)) {
    lifecycle.phase = 'completed'
  } else {
    lifecycle.phase = 'failed'
    lifecycle.reason = 'Codex 已结束本轮工具执行，但没有返回最终回复'
  }

  record.task.status = taskStatusForPhase(lifecycle.phase)
  record.task.updatedAt = lifecycle.lastActivityAt
  return lifecycle
}

export function canReuseLifecycleSession(record: LifecycleRecord, isRuntimeFailure: FailurePredicate) {
  const lifecycle = ensureTaskLifecycle(record, isRuntimeFailure)
  if (!record.task.sessionId) return false
  if (lifecycle.phase === 'interrupted') return true
  return lifecycle.phase === 'completed' && hasFinalAssistantReply(record, isRuntimeFailure)
}
