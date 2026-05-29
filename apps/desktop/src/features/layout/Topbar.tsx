import { Check, Loader2, LogOut, UserRound } from 'lucide-react'
import type { AccountUser, CodexTask } from '@eaw/shared'
import type { RuntimeState } from '../runtime/types'
import { statusText } from '../../tasks'
import { TokenMeter } from '../../ui/TokenMeter'

export function Topbar({
  activeTask,
  authUser,
  isWelcome,
  onLogout,
  onRecharge,
  runtimeState,
  showStatusBadge,
}: {
  activeTask: CodexTask
  authUser: AccountUser
  isWelcome: boolean
  onLogout: () => void
  onRecharge: () => void
  runtimeState: RuntimeState
  showStatusBadge: boolean
}) {
  return (
    <header className={`topbar ${isWelcome ? 'welcome' : ''}`}>
      <div className="topbar-title">{!isWelcome && <h1>{activeTask.title}</h1>}</div>
      <div className="topbar-actions">
        <TokenMeter onClick={onRecharge} user={authUser} />
        <div
          className={`runtime-dot ${runtimeState}`}
          title={runtimeState === 'online' ? '本地 Runtime 正常运行' : runtimeState === 'checking' ? '正在连接本地 Runtime' : '本地 Runtime 未连接'}
        >
          <span />
          <b>{runtimeState === 'online' ? '本地运行' : runtimeState === 'checking' ? '连接中' : '未连接'}</b>
        </div>
        {showStatusBadge && (
          <div className={`status-badge ${activeTask.status}`}>
            {activeTask.status === 'running' || activeTask.status === 'queued' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
            {runtimeState === 'offline' ? '未连接' : statusText(activeTask.status)}
          </div>
        )}
        <button className="account-chip" onClick={onLogout} title={`退出 ${authUser.email}`} type="button">
          <UserRound size={14} />
          <span>{authUser.name || authUser.email}</span>
          <LogOut size={13} />
        </button>
      </div>
    </header>
  )
}
