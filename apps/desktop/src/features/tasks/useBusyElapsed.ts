import { useEffect, useMemo, useState } from 'react'
import type { CodexTask } from '@eaw/shared'
import { nowIso } from '../../tasks'

export function useBusyElapsed(task: CodexTask, isBusy: boolean) {
  const [nowTick, setNowTick] = useState(Date.now())
  const latestUserTurn = useMemo(() => [...task.transcript].reverse().find((item) => item.role === 'user'), [task.transcript])
  const busyStartedAt = new Date(latestUserTurn?.timestamp ?? task.createdAt ?? nowIso()).getTime()

  useEffect(() => {
    if (!isBusy) return
    setNowTick(Date.now())
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [isBusy, task.id])

  return isBusy ? Math.max(0, nowTick - busyStartedAt) : 0
}
