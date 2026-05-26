import { Bot, Check, FolderOpen, Loader2, Plus, Send, Settings, Terminal, UserRound } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import './styles.css'

const runtimeUrl = import.meta.env.VITE_CODEX_RUNTIME_URL ?? 'http://127.0.0.1:4100'
const defaultWorkspace = import.meta.env.VITE_DEFAULT_WORKSPACE ?? '/Users/a1/Documents/Codex/2026-05-26/codex'
const localEmployeeId = import.meta.env.VITE_EMPLOYEE_ID ?? 'u-1001'

type TranscriptItem = CodexTask['transcript'][number]
type RuntimeState = 'checking' | 'online' | 'offline'

const welcomeTask: CodexTask = {
  id: 'welcome',
  title: '新任务',
  status: 'completed',
  workspace: defaultWorkspace,
  transcript: [
    {
      role: 'assistant',
      content: '说一句你想让我做的事。我会使用内置 Codex 在本地工作区执行，可以读文件、运行命令、修改代码、跑测试。',
      timestamp: new Date().toISOString(),
    },
  ],
}

function nowIso() {
  return new Date().toISOString()
}

function statusText(status: CodexTask['status']) {
  return {
    queued: '排队',
    running: '运行中',
    needs_approval: '待确认',
    completed: '完成',
    failed: '失败',
  }[status]
}

function taskSortValue(task: CodexTask) {
  return new Date(task.createdAt ?? task.transcript[0]?.timestamp ?? 0).getTime()
}

function normalizeTask(task: CodexTask): CodexTask {
  return {
    ...task,
    title: task.title?.trim() || task.transcript.find((item) => item.role === 'user')?.content.slice(0, 36) || '新任务',
    transcript: task.transcript ?? [],
  }
}

function eventToTranscript(event: CodexTaskEvent) {
  return {
    role: event.role,
    content: event.content,
    timestamp: event.timestamp,
  }
}

function mergeTask(tasks: CodexTask[], next: CodexTask) {
  const normalized = normalizeTask(next)
  const withoutWelcome = tasks.filter((task) => task.id !== 'welcome')
  const exists = withoutWelcome.some((task) => task.id === normalized.id)
  const merged = exists
    ? withoutWelcome.map((task) => (task.id === normalized.id ? normalized : task))
    : [normalized, ...withoutWelcome]

  return merged.sort((a, b) => taskSortValue(b) - taskSortValue(a))
}

function replaceTask(tasks: CodexTask[], oldTaskId: string, next: CodexTask) {
  return mergeTask(
    tasks.filter((task) => task.id !== oldTaskId),
    next,
  )
}

function shouldShowMessage(item: TranscriptItem) {
  if (item.role !== 'system') return true
  return (
    item.content.includes('Codex Runtime 没连上') ||
    item.content.includes('任务创建失败') ||
    item.content.includes('发送失败') ||
    item.content.includes('退出') ||
    item.content.includes('失败') ||
    item.content.includes('错误') ||
    item.content.includes('error')
  )
}

function messageLabel(role: TranscriptItem['role']) {
  return {
    assistant: 'Codex',
    tool: '命令',
    system: '系统',
    user: '你',
  }[role]
}

function eventStatus(event: CodexTaskEvent, fallback: CodexTask['status']): CodexTask['status'] {
  if (event.type === 'process.exit') return event.content.includes('完成') ? 'completed' : 'failed'
  if (event.type === 'turn.failed' || event.type === 'error') return 'failed'
  if (event.type === 'turn.completed') return 'completed'
  if (event.type === 'turn.started' || event.type === 'thread.started' || event.type === 'tool') return 'running'
  return fallback
}

function mergeEventIntoTask(task: CodexTask, event: CodexTaskEvent): CodexTask {
  const seen = task.transcript.some((item) => item.timestamp === event.timestamp && item.content === event.content && item.role === event.role)
  const transcript = seen ? task.transcript : [...task.transcript, eventToTranscript(event)]
  return { ...task, status: eventStatus(event, task.status), transcript }
}

function hasCodexActivity(task: CodexTask) {
  return task.transcript.some((item) => (item.role === 'assistant' || item.role === 'tool') && item.content.trim())
}

function buildPendingTask(promptText: string, workspacePath: string): CodexTask {
  const timestamp = nowIso()
  return {
    id: `pending-${Date.now()}`,
    title: promptText.slice(0, 36),
    status: 'queued',
    workspace: workspacePath,
    createdAt: timestamp,
    exitCode: null,
    transcript: [
      {
        role: 'user',
        content: promptText,
        timestamp,
      },
    ],
  }
}

function buildLocalErrorTask(error: unknown, workspacePath: string): CodexTask {
  const timestamp = nowIso()
  return {
    id: `error-${Date.now()}`,
    title: '发送失败',
    status: 'failed',
    workspace: workspacePath,
    createdAt: timestamp,
    exitCode: null,
    transcript: [
      {
        role: 'system',
        content: `发送失败：${error instanceof Error ? error.message : String(error)}`,
        timestamp,
      },
    ],
  }
}

function TranscriptMessage({ animate, item, label }: { animate: boolean; item: TranscriptItem; label: string }) {
  const [visibleText, setVisibleText] = useState(animate && item.role === 'assistant' ? '' : item.content)

  useEffect(() => {
    if (!animate || item.role !== 'assistant') {
      setVisibleText(item.content)
      return
    }

    setVisibleText('')
    let index = 0
    const step = () => {
      index = Math.min(item.content.length, index + Math.max(1, Math.ceil(item.content.length / 80)))
      setVisibleText(item.content.slice(0, index))
      if (index >= item.content.length) window.clearInterval(timer)
    }
    const timer = window.setInterval(step, 18)
    step()

    return () => window.clearInterval(timer)
  }, [animate, item.content, item.role, item.timestamp])

  return (
    <article className={`message ${item.role}`}>
      <div className="message-label">{label}</div>
      <div className="message-body">
        {visibleText}
        {animate && item.role === 'assistant' && visibleText.length < item.content.length ? <span className="stream-caret" /> : null}
      </div>
    </article>
  )
}

function DesktopApp() {
  const [tasks, setTasks] = useState<CodexTask[]>([welcomeTask])
  const [activeTaskId, setActiveTaskId] = useState(welcomeTask.id)
  const [prompt, setPrompt] = useState('')
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('checking')
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const seenEventsRef = useRef<Set<string>>(new Set())

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) ?? tasks[0], [activeTaskId, tasks])
  const visibleTranscript = useMemo(() => activeTask.transcript.filter(shouldShowMessage), [activeTask.transcript])
  const isBusy = activeTask.status === 'queued' || activeTask.status === 'running'

  useEffect(() => {
    fetch(`${runtimeUrl}/health`)
      .then((response) => {
        if (!response.ok) throw new Error('offline')
        setRuntimeState('online')
      })
      .catch(() => setRuntimeState('offline'))

    fetch(`${runtimeUrl}/api/codex/tasks`)
      .then((response) => response.json())
      .then((payload: { data?: CodexTask[] }) => {
        setRuntimeState('online')
        if (payload.data?.length) {
          const nextTasks = payload.data.map(normalizeTask).sort((a, b) => taskSortValue(b) - taskSortValue(a))
          setTasks(nextTasks)
          setActiveTaskId((current) => (current === welcomeTask.id ? nextTasks[0]?.id ?? current : current))
        }
      })
      .catch(() => {
        setRuntimeState('offline')
        setTasks([
          {
            ...welcomeTask,
            transcript: [
              ...welcomeTask.transcript,
              {
                role: 'system',
                content: `Codex Runtime 没连上：${runtimeUrl}`,
                timestamp: nowIso(),
              },
            ],
          },
        ])
      })
  }, [])

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    })
  }, [visibleTranscript.length, activeTask?.id])

  useEffect(() => {
    if (!activeTask || activeTask.id === 'welcome') return

    let pollTimer: number | undefined
    const source = new EventSource(`${runtimeUrl}/api/codex/tasks/${activeTask.id}/events`)

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as CodexTaskEvent
      if (seenEventsRef.current.has(event.id)) return
      seenEventsRef.current.add(event.id)
      setRuntimeState('online')
      setTasks((current) =>
        current.map((task) => (task.id === event.taskId ? mergeEventIntoTask(task, event) : task)),
      )
    }

    source.onerror = () => {
      source.close()
    }

    pollTimer = window.setInterval(() => {
      fetch(`${runtimeUrl}/api/codex/tasks/${activeTask.id}`)
        .then((response) => response.json())
        .then((payload: { data?: CodexTask }) => {
          setRuntimeState('online')
          if (payload.data) setTasks((current) => mergeTask(current, payload.data!))
        })
        .catch(() => setRuntimeState('offline'))
    }, 1200)

    return () => {
      source.close()
      if (pollTimer) window.clearInterval(pollTimer)
    }
  }, [activeTask?.id])

  async function submitTask() {
    const promptText = prompt.trim()
    const workspacePath = workspace.trim() || defaultWorkspace
    if (!promptText || isSubmitting) return

    setIsSubmitting(true)
    const pendingTask = buildPendingTask(promptText, workspacePath)
    setTasks((current) => mergeTask(current, pendingTask))
    setActiveTaskId(pendingTask.id)
    setPrompt('')

    try {
      const response = await fetch(`${runtimeUrl}/api/codex/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: localEmployeeId,
          workspace: workspacePath,
          prompt: promptText,
        }),
      })
      const payload = (await response.json()) as { data?: CodexTask; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Runtime 返回 ${response.status}`)
      if (!payload.data) throw new Error(payload.error ?? '任务创建失败')
      setRuntimeState('online')
      setTasks((current) => replaceTask(current, pendingTask.id, payload.data!))
      setActiveTaskId(payload.data.id)
    } catch (error) {
      setRuntimeState('offline')
      const errorTask = buildLocalErrorTask(error, workspacePath)
      setTasks((current) => replaceTask(current, pendingTask.id, errorTask))
      setActiveTaskId(errorTask.id)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="desktop-shell">
      <aside className="sidebar">
        <div className="window-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="brand">
          <Bot size={18} />
          <strong>墨渊</strong>
        </div>
        <button
          className="new-task"
          onClick={() => {
            setActiveTaskId('welcome')
            setPrompt('')
          }}
        >
          <Plus size={16} />
          新任务
        </button>
        <div className="task-list">
          {tasks.map((task) => (
            <button
              className={task.id === activeTask.id ? 'task-item active' : 'task-item'}
              key={task.id}
              onClick={() => setActiveTaskId(task.id)}
            >
              <span>{task.title}</span>
              <small>{statusText(task.status)}</small>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">
          <button title="工作区">
            <FolderOpen size={17} />
          </button>
          <button title="设置">
            <Settings size={17} />
          </button>
          <button title="账号">
            <UserRound size={17} />
          </button>
        </div>
      </aside>

      <section className="main-pane">
        <header className="topbar">
          <div>
            <h1>{activeTask.title}</h1>
            <label className="workspace-field">
              <Terminal size={15} />
              <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
            </label>
          </div>
          <div className="topbar-actions">
            <div className={`runtime-dot ${runtimeState}`}>{runtimeState === 'online' ? 'Runtime online' : runtimeState === 'checking' ? 'Checking runtime' : 'Runtime offline'}</div>
            <div className={`status-badge ${activeTask.status}`}>
              {activeTask.status === 'running' || activeTask.status === 'queued' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
              {runtimeState === 'offline' ? '未连接' : statusText(activeTask.status)}
            </div>
          </div>
        </header>

        <div className="transcript" ref={transcriptRef}>
          {visibleTranscript.map((item, index) => {
            const isLatestAssistant = item.role === 'assistant' && index === visibleTranscript.length - 1
            return <TranscriptMessage animate={isLatestAssistant} item={item} key={`${item.timestamp}-${index}`} label={messageLabel(item.role)} />
          })}
          {isBusy && !hasCodexActivity(activeTask) && (
            <article className="message assistant pending">
              <div className="message-label">Codex</div>
              <div className="message-body">
                <span className="typing-dot" />
                正在处理...
              </div>
            </article>
          )}
        </div>

        <footer className="composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitTask()
              }
            }}
            placeholder="让 Codex 做点什么..."
          />
          <button disabled={isSubmitting || !prompt.trim()} onClick={submitTask}>
            {isSubmitting ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
          </button>
        </footer>
      </section>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
)
