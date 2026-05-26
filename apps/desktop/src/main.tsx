import {
  Bell,
  Bot,
  CheckCircle2,
  ChevronRight,
  FileText,
  FolderOpen,
  KeyRound,
  MessageSquareText,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  UserRound,
} from 'lucide-react'
import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import './styles.css'

const runtimeUrl = import.meta.env.VITE_CODEX_RUNTIME_URL ?? 'http://127.0.0.1:4100'
const defaultWorkspace = import.meta.env.VITE_DEFAULT_WORKSPACE ?? '/Users/a1/Documents/Codex/2026-05-26/codex'

const starterTask: CodexTask = {
  id: 'welcome',
  title: '墨渊 Desktop',
  status: 'completed',
  workspace: defaultWorkspace,
  transcript: [
    {
      role: 'assistant',
      content: '我是内置 Codex Runtime 的员工桌面端。输入任务后，我会在本机工作区执行，并把过程实时显示在这里。',
      timestamp: new Date().toISOString(),
    },
  ],
}

const workspaces = ['我的工作区', '销售一组', '华东客户项目', '日报周报', '企业知识库']

function statusText(status: CodexTask['status']) {
  return {
    queued: '排队中',
    running: '执行中',
    needs_approval: '待确认',
    completed: '已完成',
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

function DesktopApp() {
  const [tasks, setTasks] = useState<CodexTask[]>([starterTask])
  const [activeTaskId, setActiveTaskId] = useState(starterTask.id)
  const [prompt, setPrompt] = useState('查看当前目录内容，判断这个项目是什么技术栈，并给我一个简短说明。')
  const [workspace, setWorkspace] = useState(defaultWorkspace)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const activeTask = useMemo(() => {
    return tasks.find((task) => task.id === activeTaskId) ?? tasks[0]
  }, [activeTaskId, tasks])

  useEffect(() => {
    fetch(`${runtimeUrl}/api/codex/tasks`)
      .then((response) => response.json())
      .then((payload: { data?: CodexTask[] }) => {
        if (payload.data?.length) {
          setTasks([starterTask, ...payload.data])
        }
      })
      .catch(() => {
        setTasks((current) => [
          {
            ...starterTask,
            transcript: [
              ...starterTask.transcript,
              {
                role: 'system',
                content: `无法连接 Codex Runtime：${runtimeUrl}`,
                timestamp: new Date().toISOString(),
              },
            ],
          },
          ...current.filter((task) => task.id !== starterTask.id),
        ])
      })
  }, [])

  useEffect(() => {
    if (!activeTask || activeTask.id === 'welcome') return

    const source = new EventSource(`${runtimeUrl}/api/codex/tasks/${activeTask.id}/events`)

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as CodexTaskEvent
      setTasks((current) =>
        current.map((task) => {
          if (task.id !== event.taskId) return task

          const nextTranscript = [...task.transcript, eventToTranscript(event)]
          const nextStatus =
            event.type === 'process.exit'
              ? event.content.includes('完成')
                ? 'completed'
                : 'failed'
              : event.type === 'turn.failed'
                ? 'failed'
                : event.type === 'turn.started'
                  ? 'running'
                  : task.status

          return {
            ...task,
            status: nextStatus,
            transcript: nextTranscript,
          }
        }),
      )
    }

    source.onerror = () => {
      source.close()
    }

    return () => source.close()
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
      const payload = (await response.json()) as { data: CodexTask }

      setTasks((current) => [payload.data, ...current.filter((task) => task.id !== 'welcome')])
      setActiveTaskId(payload.data.id)
      setPrompt('')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="desktop-shell">
      <aside className="rail">
        <div className="traffic-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <button className="rail-action active" title="AI 工作区">
          <Bot size={20} />
        </button>
        <button className="rail-action" title="文件">
          <FolderOpen size={20} />
        </button>
        <button className="rail-action" title="消息">
          <MessageSquareText size={20} />
        </button>
        <button className="rail-action" title="知识库">
          <FileText size={20} />
        </button>
        <button className="rail-action bottom" title="账号">
          <UserRound size={20} />
        </button>
      </aside>

      <aside className="workspace-list">
        <div className="desktop-brand">
          <Sparkles size={18} />
          <strong>墨渊 Desktop</strong>
        </div>
        <label className="search-box">
          <Search size={16} />
          <input placeholder="搜索工作区或任务" />
        </label>
        <div className="workspace-section">
          <span className="caption">工作区</span>
          {workspaces.map((name, index) => (
            <button className={index === 0 ? 'workspace-item active' : 'workspace-item'} key={name}>
              <span>{name}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        <div className="workspace-section">
          <span className="caption">Codex 任务</span>
          {tasks.map((task) => (
            <button
              className={task.id === activeTask.id ? 'task-pill active' : 'task-pill'}
              key={task.id}
              onClick={() => setActiveTaskId(task.id)}
            >
              <span>{task.title}</span>
              <small>{statusText(task.status)}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="conversation">
        <header className="conversation-header">
          <div>
            <span className="caption">当前任务</span>
            <h1>{activeTask.title}</h1>
            <p>{activeTask.workspace}</p>
          </div>
          <div className="header-actions">
            <button className="icon-button" title="通知">
              <Bell size={18} />
            </button>
            <button className="run-button" disabled={isSubmitting} onClick={submitTask}>
              <Play size={16} />
              {isSubmitting ? '启动中' : '运行'}
            </button>
          </div>
        </header>

        <div className="transcript">
          {activeTask.transcript.map((item, index) => (
            <article className={`message ${item.role}`} key={`${item.timestamp}-${index}`}>
              <div className="message-meta">
                <span>{item.role === 'assistant' ? 'Codex' : item.role === 'tool' ? '工具' : item.role === 'system' ? '系统' : '你'}</span>
                <small>{new Date(item.timestamp).toLocaleTimeString()}</small>
              </div>
              <p>{item.content}</p>
            </article>
          ))}
        </div>

        <footer className="composer">
          <label className="workspace-input">
            <span>工作目录</span>
            <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
          </label>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <div className="composer-footer">
            <span>内置 Codex · 企业中转 · 本地工作区</span>
            <button disabled={isSubmitting} onClick={submitTask}>
              <Sparkles size={16} />
              交给 Codex
            </button>
          </div>
        </footer>
      </section>

      <aside className="inspector">
        <section className="inspector-card emphasis">
          <div className="inspector-title">
            <ShieldCheck size={18} />
            <strong>企业策略</strong>
          </div>
          <div className="policy-line">
            <span>模型中转</span>
            <strong>ai.blector.com</strong>
          </div>
          <div className="policy-line">
            <span>执行沙箱</span>
            <strong>工作区可写</strong>
          </div>
          <div className="policy-line">
            <span>审计</span>
            <strong>全量开启</strong>
          </div>
        </section>

        <section className="inspector-card approval">
          <div className="inspector-title">
            <KeyRound size={18} />
            <strong>开箱即用</strong>
          </div>
          <p>Codex 二进制随墨渊 Desktop 一起安装，员工不需要单独安装或配置 Codex。</p>
        </section>

        <section className="inspector-card">
          <div className="inspector-title">
            <TerminalSquare size={18} />
            <strong>Runtime</strong>
          </div>
          <ul className="runtime-list">
            <li>
              <CheckCircle2 size={15} />
              @openai/codex 随包内置
            </li>
            <li>
              <CheckCircle2 size={15} />
              事件流实时回传桌面端
            </li>
            <li>
              <CheckCircle2 size={15} />
              配置目录由企业托管
            </li>
          </ul>
        </section>
      </aside>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
)
