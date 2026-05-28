import { useCallback, useState } from 'react'

export function useTaskDrafts(activeTaskId: string) {
  const [draftByTaskId, setDraftByTaskId] = useState<Record<string, string>>({})
  const prompt = draftByTaskId[activeTaskId] ?? ''

  const setPrompt = useCallback((value: string, taskId = activeTaskId) => {
    setDraftByTaskId((current) => ({ ...current, [taskId]: value }))
  }, [activeTaskId])

  return { prompt, setPrompt }
}
