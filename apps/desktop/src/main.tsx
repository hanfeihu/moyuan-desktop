import { Bot, Check, FolderOpen, Loader2, Plus, Send, Settings, Terminal, UserRound } from 'lucide-react'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import './styles.css'

const runtimeUrl = import.meta.env.VITE_CODEX_RUNTIME_URL ?? 'http://127.0.0.1:4100'
const defaultWorkspace = import.meta.env.VITE_DEFAULT_WORKSPACE ?? '/Users/a1/Documents/Codex/2026-05-26/codex'

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

function statusText(status: CodexTask['status']) {
  return {
    queued: '排队',
    running: '运行中',
    needs_approval: '待确认',
    completed: '完成',
    failed: '失败',
  }[status]
}

function eventToTranscript(event: CodexTaskEvent) {
  return {
    role: event.role,
    content: event.content,
    timestamp: event.timestamp,
  }
}

function mergeTask(tasks: CodexTask[], next: CodexTask) {
  const exists = tasks.some((task) => task.id === next.id)
  if (!exists) return [next, ...tasks.filter((task) => task.id !== 'welcome')]
  return tasks.map((task) => (task.id === next.id ? next : task))
}

function DesktopApp() {
  const [tasks, setTasks] = useState<CodexTask[]>([welcomeTask])
  const [activeTaskId, setActiveTaskId] = useState(welcomeTask.id)
  const [prompt, setPrompt] = useState('查看当前目录内容，判断这个项目是什么技术栈，并给我一个简短说明。')
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) ?? tasks[0], [activeTaskId, tasks])

  useEffect(() => {
    fetch(`${runtimeUrl}/api/codex/tasks`)
      .then((response) => response.json())
      .then((payload: { data?: CodexTask[] }) => {
        if (payload.data?.length) setTasks([...payload.data, welcomeTask])
      })
      .catch(() => {
        setTasks([
          {
            ...welcomeTask,
            transcript: [
              ...welcomeTask.transcript,
              {
                role: 'system',
                content: `Codex Runtime 没连上：${runtimeUrl}`,
                timestamp: new Date().toISOString(),
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
  }, [activeTask?.transcript.length])

  useEffect(() => {
    if (!activeTask || activeTask.id === 'welcome') return

    let pollTimer: number | undefined
    const source = new EventSource(`${runtimeUrl}/api/codex/tasks/${activeTask.id}/events`)

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as CodexTaskEvent
      setTasks((current) =>
        current.map((task) => {
          if (task.id !== event.taskId) return task
          const seen = task.transcript.some((item) => item.timestamp === event.timestamp && item.content === event.content)
          const transcript = seen ? task.transcript : [...task.transcript, eventToTranscript(event)]
          const status =
            event.type === 'process.exit'
              ? event.content.includes('完成')
                ? 'completed'
                : 'failed'
              : event.type === 'turn.failed'
                ? 'failed'
                : event.type === 'turn.started'
                  ? 'running'
                  : task.status
          return { ...task, status, transcript }
        }),
      )
    }

    source.onerror = () => {
      source.close()
    }

    pollTimer = window.setInterval(() => {
      fetch(`${runtimeUrl}/api/codex/tasks/${activeTask.id}`)
        .then((response) => response.json())
        .then((payload: { data?: CodexTask }) => {
          if (payload.data) setTasks((current) => mergeTask(current, payload.data!))
        })
        .catch(() => undefined)
    }, 1200)

    return () => {
      source.close()
      if (pollTimer) window.clearInterval(pollTimer)
    }
  }, [activeTask?.id])

  async function submitTask() {
    if (!prompt.trim() || isSubmitting) return

    setIsSubmitting(true)
    try {
      const response = await fetch(`${runtimeUrl}/api/codex/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: 'u-1001',
          workspace,
          prompt,
        }),
      })
      const payload = (await response.json()) as { data?: CodexTask; error?: string }
      if (!payload.data) throw new Error(payload.error ?? '任务创建失败')
      setTasks((current) => mergeTask(current, payload.data!))
      setActiveTaskId(payload.data.id)
      setPrompt('')
    } catch (error) {
      setTasks((current) =>
        mergeTask(current, {
          ...welcomeTask,
          id: `error-${Date.now()}`,
          title: '发送失败',
          status: 'failed',
          transcript: [
            {
              role: 'system',
              content: error instanceof Error ? error.message : String(error),
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      )
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
        <button className="new-task" onClick={() => setActiveTaskId('welcome')}>
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
          <div className={`status-badge ${activeTask.status}`}>
            {activeTask.status === 'running' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            {statusText(activeTask.status)}
          </div>
        </header>

        <div className="transcript" ref={transcriptRef}>
          {activeTask.transcript.map((item, index) => (
            <article className={`message ${item.role}`} key={`${item.timestamp}-${index}`}>
              <div className="message-label">
                {item.role === 'assistant' ? 'Codex' : item.role === 'tool' ? '命令' : item.role === 'system' ? '系统' : '你'}
              </div>
              <div className="message-body">{item.content}</div>
            </article>
          ))}
        </div>

        <footer className="composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
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
