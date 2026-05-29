import { Zap } from 'lucide-react'
import type { AccountUser } from '@eaw/shared'
import { formatTokenNumber } from '../utils/format'

export function TokenMeter({ onClick, user }: { onClick?: () => void; user: AccountUser }) {
  const percent = user.tokenBudget > 0 ? Math.min(100, Math.round((user.tokenUsed / user.tokenBudget) * 100)) : 0
  const remaining = Math.max(0, user.tokenBudget - user.tokenUsed)
  const state = user.tokenBudget <= 0 ? 'unissued' : remaining <= 0 ? 'depleted' : 'normal'
  const label = state === 'unissued' ? 'Token 额度' : state === 'depleted' ? '本期额度已用完' : 'Token 额度'
  const value = state === 'unissued' ? '尚未派发' : formatTokenNumber(remaining)

  return (
    <button className={`token-meter ${state}`} onClick={onClick} title={`已用 ${user.tokenUsed} / ${user.tokenBudget} Token，点击充值`} type="button">
      <div className="token-meter-icon">
        <Zap size={14} />
      </div>
      <div className="token-meter-copy">
        <span>{label}</span>
        <strong>
          {value}
          {state === 'unissued' ? null : <em> 可用</em>}
        </strong>
      </div>
      <div className="token-meter-bar">
        <i style={{ width: `${percent}%` }} />
      </div>
    </button>
  )
}
