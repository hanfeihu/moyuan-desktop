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
import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { CodexTask } from '@eaw/shared'
import './styles.css'

const tasks: CodexTask[] = [
  {
    id: 'task-1',
    title: '生成今日客户跟进日报',
    status: 'needs_approval',
    workspace: '销售一组 / 华东客户',
    transcript: [
      { role: 'user', content: '根据今天企微和飞书沟通，生成客户跟进日报。', timestamp: '10:18' },
      { role: 'assistant', content: '已整理 3 个客户进展，发现 1 个审批延迟风险。需要读取客户报价表。', timestamp: '10:19' },
      { role: 'tool', content: '请求权限：读取 /客户资料/华东项目/报价表.xlsx', timestamp: '10:19' },
    ],
  },
  {
    id: 'task-2',
    title: '把会议纪要拆成待办',
    status: 'running',
    workspace: '交付中心 / 飞书项目',
    transcript: [
      { role: 'assistant', content: '正在从会议纪要中识别负责人、截止时间和风险项。', timestamp: '09:42' },
    ],
  },
  {
    id: 'task-3',
    title: '查询企业知识库里的报销规则',
    status: 'completed',
    workspace: '我的工作区',
    transcript: [
      { role: 'assistant', content: '已引用 2 篇制度文档，并生成可提交的报销说明。', timestamp: '09:12' },
    ],
  },
]

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

function DesktopApp() {
  const [activeTask, setActiveTask] = useState(tasks[0])
  const [prompt, setPrompt] = useState('帮我把今天的客户沟通、会议记录和任务进展整理成日报，风险项单独列出来。')

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
          <strong>企业 Codex</strong>
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
          <span className="caption">正在执行</span>
          {tasks.map((task) => (
            <button
              className={task.id === activeTask.id ? 'task-pill active' : 'task-pill'}
              key={task.id}
              onClick={() => setActiveTask(task)}
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
            <button className="run-button">
              <Play size={16} />
              运行
            </button>
          </div>
        </header>

        <div className="transcript">
          {activeTask.transcript.map((item, index) => (
            <article className={`message ${item.role}`} key={`${item.timestamp}-${index}`}>
              <div className="message-meta">
                <span>{item.role === 'assistant' ? 'Codex' : item.role === 'tool' ? '工具请求' : '你'}</span>
                <small>{item.timestamp}</small>
              </div>
              <p>{item.content}</p>
            </article>
          ))}

          <article className="message assistant">
            <div className="message-meta">
              <span>Codex</span>
              <small>现在</small>
            </div>
            <p>
              我会在本机工作区里执行任务，只访问企业策略允许的数据。涉及外发、写入系统、读取敏感文件时，会先停下来让你确认。
            </p>
          </article>
        </div>

        <footer className="composer">
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <div className="composer-footer">
            <span>已连接：企业微信、飞书、企业知识库、Codex Runtime</span>
            <button>
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
            <span>数据出域</span>
            <strong>禁止</strong>
          </div>
          <div className="policy-line">
            <span>审计</span>
            <strong>全量开启</strong>
          </div>
        </section>

        <section className="inspector-card approval">
          <div className="inspector-title">
            <KeyRound size={18} />
            <strong>等待确认</strong>
          </div>
          <p>Codex 请求读取客户报价表，用于生成日报中的客户进展和风险判断。</p>
          <div className="approval-actions">
            <button className="allow">允许一次</button>
            <button className="deny">拒绝</button>
          </div>
        </section>

        <section className="inspector-card">
          <div className="inspector-title">
            <TerminalSquare size={18} />
            <strong>Runtime</strong>
          </div>
          <ul className="runtime-list">
            <li>
              <CheckCircle2 size={15} />
              @openai/codex 已内置
            </li>
            <li>
              <CheckCircle2 size={15} />
              工具调用进入审计流
            </li>
            <li>
              <CheckCircle2 size={15} />
              高风险动作人工确认
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
