import { useEffect, useRef, useState } from 'react'
import { AccountCenter } from '../features/account/AccountCenter'
import { AuthScreen } from '../features/auth/AuthScreen'
import { useAuth } from '../features/auth/useAuth'
import { RechargeDialog } from '../features/billing/RechargeDialog'
import { Composer } from '../features/chat/Composer'
import { TaskProgressCard } from '../features/chat/TaskProgressCard'
import { Transcript } from '../features/chat/Transcript'
import { useComposerTextarea } from '../features/chat/useComposerTextarea'
import { useTranscriptAutoScroll } from '../features/chat/useTranscriptAutoScroll'
import { Sidebar } from '../features/layout/Sidebar'
import { Topbar } from '../features/layout/Topbar'
import { useDesktopHotkeys } from '../features/layout/useDesktopHotkeys'
import { StoryboardBoard } from '../features/storyboard/StoryboardBoard'
import { CharacterBoard } from '../features/storyboard/CharacterBoard'
import { FaceMaskEditor } from '../features/storyboard/FaceMaskEditor'
import { useStoryboard } from '../features/storyboard/useStoryboard'
import { useTaskController } from '../features/tasks/useTaskController'
import { readExecutionSettings, writeExecutionSettings, type ExecutionSettings } from '../config'
import { uploadDiagnosticsSnapshot } from '../diagnostics'
import { logClientEvent } from '../logger'

const reasoningOrder: ExecutionSettings['reasoningEffort'][] = ['low', 'medium', 'high', 'xhigh']
const sandboxOrder: ExecutionSettings['sandboxMode'][] = ['read-only', 'workspace-write', 'danger-full-access']

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
    refreshUser,
    setAuthMode,
    setAuthUser,
    submitAuth,
  } = useAuth()
  const mainPaneRef = useRef<HTMLElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const [executionSettings, setExecutionSettings] = useState(readExecutionSettings)
  const [accountCenterOpen, setAccountCenterOpen] = useState(false)
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const [storyboardMode, setStoryboardMode] = useState(false)
  const [sidePanelTab, setSidePanelTab] = useState<'task' | 'storyboard' | 'characters'>('task')
  const [maskTarget, setMaskTarget] = useState<
    { kind: 'shot' | 'character'; id: string; url: string; title: string } | null
  >(null)
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
    executionSettings,
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

  const storyboard = useStoryboard({
    activeTaskId: taskController.activeTask?.id ?? 'welcome',
    authToken,
    authUser,
    executionSettings,
  })

  function handleComposerSubmit() {
    if (storyboardMode) {
      const script = taskController.prompt
      if (!script.trim()) return
      taskController.setPrompt('')
      setSidePanelTab('storyboard')
      void storyboard.requestBreakdown(script)
      return
    }
    void taskController.submitTask()
  }

  useEffect(() => {
    window.sessionStorage.removeItem('moyuan.react_queue_error_reload')
    logClientEvent('app.mounted', {
      authState,
      userAgent: window.navigator.userAgent,
    })
  }, [])

  useEffect(() => {
    if (authState !== 'signed-in') return
    void uploadDiagnosticsSnapshot('signed-in')
  }, [authState])

  function updateExecutionSettings(next: ExecutionSettings) {
    setExecutionSettings(next)
    writeExecutionSettings(next)
    logClientEvent('execution_settings.changed', next)
  }

  function cycleReasoningEffort() {
    const index = reasoningOrder.indexOf(executionSettings.reasoningEffort)
    updateExecutionSettings({
      ...executionSettings,
      reasoningEffort: reasoningOrder[(index + 1) % reasoningOrder.length],
    })
  }

  function cycleSandboxMode() {
    const index = sandboxOrder.indexOf(executionSettings.sandboxMode)
    updateExecutionSettings({
      ...executionSettings,
      sandboxMode: sandboxOrder[(index + 1) % sandboxOrder.length],
    })
  }

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
        onAccountOpen={() => setAccountCenterOpen(true)}
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
          onRecharge={() => setRechargeOpen(true)}
          runtimeState={taskController.runtimeState}
          showStatusBadge={taskController.showStatusBadge}
        />
        <div className="conversation-layout">
          <div className="conversation-column">
            <Transcript
              activeTask={taskController.activeTask}
              busyElapsed={taskController.busyElapsed}
              isWelcome={taskController.isWelcome}
              onRegenerateResource={taskController.regenerateResource}
              shouldShowThinking={taskController.shouldShowThinking}
              transcriptBottomRef={transcriptBottomRef}
              transcriptRef={transcriptRef}
              visibleTranscript={taskController.visibleTranscript}
            />
            <Composer
              attachments={taskController.attachments}
              canSubmit={taskController.canSubmit}
              composerRef={composerRef}
              executionSettings={executionSettings}
              isBusy={taskController.isBusy}
              isCancelling={taskController.isCancelling}
              isSubmitting={taskController.isSubmitting}
              mentionImages={taskController.mentionImages}
              onMentionSelect={taskController.attachConversationImage}
              onRemoveAttachment={taskController.removeAttachment}
              onSelectImages={(files) => void taskController.addImageAttachments(files)}
              onPromptChange={(value) => taskController.setPrompt(value)}
              onReasoningToggle={cycleReasoningEffort}
              onSandboxToggle={cycleSandboxMode}
              onStop={taskController.stopActiveTask}
              onSubmit={handleComposerSubmit}
              placeholder={taskController.placeholder}
              prompt={taskController.prompt}
              quotaDepleted={taskController.quotaDepleted}
              quotaNotice={taskController.quotaNotice}
              storyboardMode={storyboardMode}
              onToggleStoryboard={() => setStoryboardMode((current) => !current)}
              textareaRef={textareaRef}
            />
          </div>
          <aside className="task-side-panel" aria-label="运行活动">
            <div className="storyboard-tabs" role="tablist">
              <button
                className={`storyboard-tab ${sidePanelTab === 'task' ? 'active' : ''}`}
                onClick={() => setSidePanelTab('task')}
                role="tab"
                aria-selected={sidePanelTab === 'task'}
                type="button"
              >
                活动
              </button>
              <button
                className={`storyboard-tab ${sidePanelTab === 'characters' ? 'active' : ''}`}
                onClick={() => setSidePanelTab('characters')}
                role="tab"
                aria-selected={sidePanelTab === 'characters'}
                type="button"
              >
                人物{storyboard.characters.length ? `（${storyboard.characters.length}）` : ''}
              </button>
              <button
                className={`storyboard-tab ${sidePanelTab === 'storyboard' ? 'active' : ''}`}
                onClick={() => setSidePanelTab('storyboard')}
                role="tab"
                aria-selected={sidePanelTab === 'storyboard'}
                type="button"
              >
                分镜{storyboard.board?.cards.length ? `（${storyboard.board.cards.length}）` : ''}
              </button>
            </div>
            {sidePanelTab === 'task' ? (
              <TaskProgressCard
                authToken={authToken}
                busyElapsed={taskController.busyElapsed}
                onPluginDefer={taskController.deferPluginRequest}
                onPluginSubmit={taskController.submitPluginRequest}
                task={taskController.activeTask}
                tasks={taskController.tasks}
              />
            ) : sidePanelTab === 'characters' ? (
              <CharacterBoard
                characters={storyboard.characters}
                extractStatus={storyboard.extractStatus}
                extractError={storyboard.extractError}
                onAdd={storyboard.addCharacter}
                onExtract={() => {
                  const script = taskController.activeTask.transcript
                    .filter((item) => item.role === 'user' || item.role === 'assistant')
                    .map((item) => item.content)
                    .join('\n\n')
                    .trim()
                  void storyboard.extractCharacters(script)
                }}
                onEdit={storyboard.editCharacter}
                onGenerate={(id) => void storyboard.generateCharacterImage(id)}
                onRemove={storyboard.removeCharacter}
                onMaskFace={(id) => {
                  const c = storyboard.characters.find((item) => item.id === id)
                  if (c?.refImageUrl) setMaskTarget({ kind: 'character', id, url: c.refImageUrl, title: c.name || '人物' })
                }}
              />
            ) : (
              <StoryboardBoard
                board={storyboard.board}
                status={storyboard.status}
                error={storyboard.error}
                characters={storyboard.characters}
                onGenerate={(cardId) => void storyboard.generateImage(cardId)}
                onEditCard={storyboard.editCard}
                onAddCard={storyboard.addCard}
                onRemoveCard={storyboard.removeCard}
                onAddCharacterToShot={storyboard.addCharacterToShot}
                onRemoveCharacterFromShot={storyboard.removeCharacterFromShot}
                onMaskShot={(cardId) => {
                  const card = storyboard.board?.cards.find((item) => item.id === cardId)
                  if (card?.imageUrl) setMaskTarget({ kind: 'shot', id: cardId, url: card.imageUrl, title: `镜 ${card.index}` })
                }}
              />
            )}
          </aside>
        </div>
        <AccountCenter
          authToken={authToken}
          onClose={() => setAccountCenterOpen(false)}
          onLogout={handleLogout}
          onRecharge={() => {
            setAccountCenterOpen(false)
            setRechargeOpen(true)
          }}
          open={accountCenterOpen}
          tasks={taskController.tasks}
          user={authUser}
        />
        <RechargeDialog authToken={authToken} onClose={() => setRechargeOpen(false)} onRefreshUser={refreshUser} open={rechargeOpen} />
        <FaceMaskEditor
          open={maskTarget !== null}
          imageUrl={maskTarget?.url ?? ''}
          title={maskTarget?.title ?? ''}
          onClose={() => setMaskTarget(null)}
          onSave={(dataUrl) => {
            if (!maskTarget) return
            return maskTarget.kind === 'shot'
              ? storyboard.setShotImage(maskTarget.id, dataUrl)
              : storyboard.setCharacterImage(maskTarget.id, dataUrl)
          }}
        />
      </section>
    </main>
  )
}
