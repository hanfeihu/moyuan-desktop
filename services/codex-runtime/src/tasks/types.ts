import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import type { TaskLifecycle } from './lifecycle.js'

export type TaskRecord = {
  task: CodexTask
  events: CodexTaskEvent[]
  subscribers: Set<(event: CodexTaskEvent) => void>
  streamItemIndexes: Map<string, number>
  lifecycle?: TaskLifecycle
  activeAssistantItemId?: string
  currentTurnId?: string
  nextTranscriptSeq?: number
  cancel?: (reason?: string) => void
  cancelRequested?: boolean
}
