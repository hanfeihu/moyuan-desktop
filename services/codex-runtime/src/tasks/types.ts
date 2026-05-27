import type { CodexTask, CodexTaskEvent } from '@eaw/shared'

export type TaskRecord = {
  task: CodexTask
  events: CodexTaskEvent[]
  subscribers: Set<(event: CodexTaskEvent) => void>
  streamItemIndexes: Map<string, number>
  activeAssistantItemId?: string
}
