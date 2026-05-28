import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { CodexTask } from '@eaw/shared'

export function useTranscriptAutoScroll({
  activeTaskId,
  activeTaskStatus,
  authState,
  composerRef,
  mainPaneRef,
  transcriptBottomRef,
  transcriptRef,
  visibleTranscriptLength,
}: {
  activeTaskId?: string
  activeTaskStatus?: CodexTask['status']
  authState: string
  composerRef: RefObject<HTMLElement>
  mainPaneRef: RefObject<HTMLElement>
  transcriptBottomRef: RefObject<HTMLDivElement>
  transcriptRef: RefObject<HTMLDivElement>
  visibleTranscriptLength: number
}) {
  const previousTaskIdRef = useRef(activeTaskId)
  const pinTranscriptToBottomRef = useRef(true)

  function isNearTranscriptBottom() {
    const transcript = transcriptRef.current
    if (!transcript) return true
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96
  }

  function scrollTranscriptToBottom(behavior: ScrollBehavior = 'auto') {
    const transcript = transcriptRef.current
    if (!transcript) return
    transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior })
    transcript.scrollTop = transcript.scrollHeight
  }

  function scheduleTranscriptBottom(behavior: ScrollBehavior = 'auto') {
    const run = () => scrollTranscriptToBottom(behavior)
    run()
    window.requestAnimationFrame(() => {
      run()
      window.requestAnimationFrame(run)
    })
    window.setTimeout(run, 80)
    window.setTimeout(run, 220)
  }

  function pinToBottom() {
    pinTranscriptToBottomRef.current = true
  }

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return

    const onScroll = () => {
      pinTranscriptToBottomRef.current = isNearTranscriptBottom()
    }
    transcript.addEventListener('scroll', onScroll, { passive: true })
    return () => transcript.removeEventListener('scroll', onScroll)
  }, [transcriptRef])

  useLayoutEffect(() => {
    const switchedTask = previousTaskIdRef.current !== activeTaskId
    previousTaskIdRef.current = activeTaskId ?? previousTaskIdRef.current

    if (switchedTask) {
      pinToBottom()
      scheduleTranscriptBottom('auto')
      void document.fonts?.ready.then(() => scheduleTranscriptBottom('auto'))
      return
    }

    if (pinTranscriptToBottomRef.current) {
      scheduleTranscriptBottom('auto')
    }
  }, [visibleTranscriptLength, activeTaskId, activeTaskStatus])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return

    let resizeFrame = 0
    const keepBottom = () => {
      if (pinTranscriptToBottomRef.current) scheduleTranscriptBottom('auto')
    }
    const keepBottomAfterLayout = () => {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(keepBottom)
    }
    const observer = new MutationObserver(keepBottom)
    const resizeObserver = new ResizeObserver(keepBottomAfterLayout)
    observer.observe(transcript, { childList: true, characterData: true, subtree: true })
    resizeObserver.observe(transcript)
    for (const child of Array.from(transcript.children)) resizeObserver.observe(child)
    window.addEventListener('moyuan:content-resized', keepBottom)

    return () => {
      window.cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('moyuan:content-resized', keepBottom)
    }
  }, [activeTaskId, visibleTranscriptLength, transcriptRef])

  useEffect(() => {
    const mainPane = mainPaneRef.current
    const composer = composerRef.current
    if (!mainPane || !composer) return

    const updateComposerSafeArea = () => {
      const composerHeight = Math.ceil(composer.getBoundingClientRect().height)
      mainPane.style.setProperty('--composer-safe-area', `${composerHeight + 72}px`)
      if (pinTranscriptToBottomRef.current) scheduleTranscriptBottom('auto')
    }
    updateComposerSafeArea()

    let resizeFrame = 0
    const updateComposerSafeAreaAfterLayout = () => {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(updateComposerSafeArea)
    }
    const resizeObserver = new ResizeObserver(updateComposerSafeAreaAfterLayout)
    resizeObserver.observe(composer)
    window.addEventListener('resize', updateComposerSafeArea)

    return () => {
      window.cancelAnimationFrame(resizeFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateComposerSafeArea)
    }
  }, [authState, activeTaskId, composerRef, mainPaneRef])

  return {
    pinToBottom,
    scheduleTranscriptBottom,
  }
}
