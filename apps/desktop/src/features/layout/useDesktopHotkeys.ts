import { useEffect, type RefObject } from 'react'

export function useDesktopHotkeys({
  focusComposer,
  onNewConversation,
}: {
  focusComposer: RefObject<HTMLTextAreaElement>
  onNewConversation: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isEditing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        onNewConversation()
      }

      if (!isEditing && event.key === '/') {
        event.preventDefault()
        focusComposer.current?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [focusComposer, onNewConversation])
}
