import type { CodexTask, CodexTaskEvent, RuntimeAttachment } from '@eaw/shared'
import type { TaskLifecycle } from './lifecycle.js'

export type TaskRecord = {
  task: CodexTask
  events: CodexTaskEvent[]
  subscribers: Set<(event: CodexTaskEvent) => void>
  streamItemIndexes: Map<string, number>
  lifecycle?: TaskLifecycle
  activeAssistantItemId?: string
  awaitingPluginInput?: boolean
  currentTurnId?: string
  currentAttachments?: RuntimeAttachment[]
  nextTranscriptSeq?: number
  cancel?: (reason?: string) => void
  cancelRequested?: boolean
  handledSkillOutcomes?: Set<'image_generation' | 'video_generation'>
}
