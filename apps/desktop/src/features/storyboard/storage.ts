import type { Storyboard } from './types'

const STORAGE_PREFIX = 'moyuan.storyboard.v1.'

export function storageKey(taskId: string) {
  return `${STORAGE_PREFIX}${taskId}`
}

export function readStoryboard(taskId: string): Storyboard | null {
  if (!taskId) return null
  try {
    const raw = window.localStorage.getItem(storageKey(taskId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Storyboard
    if (!parsed || !Array.isArray(parsed.cards)) return null
    // 向后兼容收口点：旧盘数据可能没有 characterNames
    const cards = parsed.cards.map((card) => ({
      ...card,
      characterNames: Array.isArray(card.characterNames) ? card.characterNames : [],
    }))
    return { ...parsed, cards }
  } catch {
    return null
  }
}

export function writeStoryboard(board: Storyboard) {
  if (!board.taskId) return
  try {
    window.localStorage.setItem(storageKey(board.taskId), JSON.stringify(board))
  } catch {
    // 忽略写入失败（配额满等），不阻塞 UI
  }
}

export function removeStoryboard(taskId: string) {
  if (!taskId) return
  try {
    window.localStorage.removeItem(storageKey(taskId))
  } catch {
    // ignore
  }
}
