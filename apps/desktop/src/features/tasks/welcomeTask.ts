import type { CodexTask } from '@eaw/shared'
import { defaultWorkspace } from '../../config'

export const welcomeTask: CodexTask = {
  id: 'welcome',
  title: '新任务',
  status: 'completed',
  workspace: defaultWorkspace,
  transcript: [],
}
