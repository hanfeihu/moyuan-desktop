import { Bot, Box, FolderOpen, Plus, Search, Settings, UserRound } from 'lucide-react'
import type { CodexTask } from '@eaw/shared'
import { taskMeta } from '../../tasks'

export function Sidebar({
  activeTaskId,
  isWelcome,
  onNewConversation,
  onSelectTask,
  tasks,
}: {
  activeTaskId: string
  isWelcome: boolean
  onNewConversation: () => void
  onSelectTask: (taskId: string) => void
  tasks: CodexTask[]
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <Bot size={18} />
        <strong>墨渊</strong>
      </div>
      <nav className="sidebar-nav" aria-label="主导航">
        <button className={isWelcome ? 'nav-item active' : 'nav-item'} onClick={onNewConversation}>
          <Plus size={16} />
          新对话
        </button>
        <button className="nav-item">
          <Search size={16} />
          搜索
        </button>
        <button className="nav-item">
          <Box size={16} />
          技能
        </button>
        <button className="nav-item">
          <FolderOpen size={16} />
          项目
        </button>
      </nav>
      <div className="section-title">对话</div>
      <div className="task-list">
        {tasks.map((task) => (
          <button className={`task-item ${task.status} ${task.id === activeTaskId ? 'active' : ''}`} key={task.id} onClick={() => onSelectTask(task.id)}>
            <span>{task.title}</span>
            <small>{taskMeta(task)}</small>
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <button title="工作区">
          <FolderOpen size={17} />
        </button>
        <button title="设置">
          <Settings size={16} />
        </button>
        <button title="账号">
          <UserRound size={17} />
        </button>
      </div>
    </aside>
  )
}
