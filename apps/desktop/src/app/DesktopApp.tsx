import { useEffect, useRef } from 'react'
import { AuthScreen } from '../features/auth/AuthScreen'
import { useAuth } from '../features/auth/useAuth'
import { Composer } from '../features/chat/Composer'
import { Transcript } from '../features/chat/Transcript'
import { useComposerTextarea } from '../features/chat/useComposerTextarea'
import { useTranscriptAutoScroll } from '../features/chat/useTranscriptAutoScroll'
import { Sidebar } from '../features/layout/Sidebar'
import { Topbar } from '../features/layout/Topbar'
import { useDesktopHotkeys } from '../features/layout/useDesktopHotkeys'
import { useTaskController } from '../features/tasks/useTaskController'
import { logClientEvent } from '../logger'

export function DesktopApp() {
  const {
    authBusy,
    authMessage,
    authMessageTone,
    authMode,
    authState,
    authToken,
    authUser,
    logout: logoutAuth,
    requestAuthCode,
    setAuthMode,
    setAuthUser,
    submitAuth,
  } = useAuth()
  const mainPaneRef = useRef<HTMLElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const focusComposer = () => textareaRef.current?.focus()
  const scrollApiRef = useRef({
    pinToBottom: () => {},
    scheduleTranscriptBottom: (_behavior: ScrollBehavior = 'auto') => {},
  })

  const taskController = useTaskController({
    authState,
    authToken,
    authUser,
    onAfterSelectTask: () => scrollApiRef.current.scheduleTranscriptBottom('auto'),
    onFocusComposer: focusComposer,
    onPinToBottom: () => scrollApiRef.current.pinToBottom(),
    setAuthUser,
  })

  scrollApiRef.current = useTranscriptAutoScroll({
    activeTaskId: taskController.activeTask?.id,
    activeTaskStatus: taskController.activeTask?.status,
    authState,
    composerRef,
    mainPaneRef,
    transcriptBottomRef,
    transcriptRef,
    visibleTranscriptLength: taskController.visibleTranscript.length,
  })
  useComposerTextarea({ activeTaskId: taskController.activeTask?.id, prompt: taskController.prompt, textareaRef })
  useDesktopHotkeys({ focusComposer: textareaRef, onNewConversation: taskController.startNewConversation })

  useEffect(() => {
    logClientEvent('app.mounted', {
      authState,
      userAgent: window.navigator.userAgent,
    })
  }, [])

  function handleLogout() {
    logClientEvent('auth.logout', { userId: authUser?.id })
    logoutAuth()
    taskController.resetTasks()
  }

  if (authState !== 'signed-in' || !authUser) {
    return (
      <AuthScreen
        authMode={authMode}
        busy={authBusy || authState === 'checking'}
        message={authState === 'checking' ? '正在检查登录状态...' : authMessage}
        messageTone={authState === 'checking' ? 'info' : authMessageTone}
        onModeChange={setAuthMode}
        onSendCode={requestAuthCode}
        onSubmit={submitAuth}
      />
    )
  }

  return (
    <main className="desktop-shell">
      <Sidebar
        activeTaskId={taskController.activeTask.id}
        isWelcome={taskController.isWelcome}
        onNewConversation={taskController.startNewConversation}
        onSelectTask={taskController.selectTask}
        tasks={taskController.tasks}
      />

      <section className="main-pane" ref={mainPaneRef}>
        <Topbar
          activeTask={taskController.activeTask}
          authUser={authUser}
          isWelcome={taskController.isWelcome}
          onLogout={handleLogout}
          runtimeState={taskController.runtimeState}
          showStatusBadge={taskController.showStatusBadge}
        />
        <Transcript
          activeTask={taskController.activeTask}
          busyElapsed={taskController.busyElapsed}
          isCancelling={taskController.isCancelling}
          isWelcome={taskController.isWelcome}
          onStop={taskController.stopActiveTask}
          shouldShowThinking={taskController.shouldShowThinking}
          transcriptBottomRef={transcriptBottomRef}
          transcriptRef={transcriptRef}
          visibleTranscript={taskController.visibleTranscript}
        />
        <Composer
          canSubmit={taskController.canSubmit}
          composerRef={composerRef}
          isBusy={taskController.isBusy}
          isCancelling={taskController.isCancelling}
          isSubmitting={taskController.isSubmitting}
          onPromptChange={(value) => taskController.setPrompt(value)}
          onStop={taskController.stopActiveTask}
          onSubmit={() => void taskController.submitTask()}
          placeholder={taskController.placeholder}
          prompt={taskController.prompt}
          quotaDepleted={taskController.quotaDepleted}
          quotaNotice={taskController.quotaNotice}
          textareaRef={textareaRef}
        />
      </section>
    </main>
  )
}
