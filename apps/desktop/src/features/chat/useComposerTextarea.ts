import { useEffect, type RefObject } from 'react'

export function useComposerTextarea({
  activeTaskId,
  prompt,
  textareaRef,
}: {
  activeTaskId?: string
  prompt: string
  textareaRef: RefObject<HTMLTextAreaElement>
}) {
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const compactHeight = prompt.trim() ? Math.max(44, textarea.scrollHeight) : 44
    textarea.style.height = `${Math.min(118, compactHeight)}px`
  }, [prompt, activeTaskId, textareaRef])
}
