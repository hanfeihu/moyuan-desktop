export type CharacterImageStatus = 'idle' | 'generating' | 'done' | 'error'

export type Character = {
  id: string
  name: string
  appearance: string
  refImageUrl?: string
  refImageTaskId?: string
  imageStatus: CharacterImageStatus
  imageError?: string
}

export type CharacterLibrary = {
  version: 1
  taskId: string
  updatedAt: number
  characters: Character[]
}

const STORAGE_PREFIX = 'moyuan.characters.v1.'

export function charactersStorageKey(taskId: string) {
  return `${STORAGE_PREFIX}${taskId}`
}

function normalizeCharacter(raw: Partial<Character> | null | undefined, fallbackIndex: number): Character | null {
  if (!raw || typeof raw !== 'object') return null
  const status: CharacterImageStatus =
    raw.imageStatus === 'generating' || raw.imageStatus === 'done' || raw.imageStatus === 'error' ? raw.imageStatus : 'idle'
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `character-${Date.now()}-${fallbackIndex}`,
    name: typeof raw.name === 'string' ? raw.name : '',
    appearance: typeof raw.appearance === 'string' ? raw.appearance : '',
    refImageUrl: typeof raw.refImageUrl === 'string' ? raw.refImageUrl : undefined,
    refImageTaskId: typeof raw.refImageTaskId === 'string' ? raw.refImageTaskId : undefined,
    // 重启后正在生成的状态没有意义，归一化为 idle（除非已有图）
    imageStatus: status === 'generating' ? (raw.refImageUrl ? 'done' : 'idle') : status,
    imageError: typeof raw.imageError === 'string' ? raw.imageError : undefined,
  }
}

export function readCharacters(taskId: string): Character[] {
  if (!taskId) return []
  try {
    const rawText = window.localStorage.getItem(charactersStorageKey(taskId))
    if (!rawText) return []
    const parsed = JSON.parse(rawText) as Partial<CharacterLibrary>
    if (!parsed || !Array.isArray(parsed.characters)) return []
    return parsed.characters
      .map((item, index) => normalizeCharacter(item as Partial<Character>, index))
      .filter((item): item is Character => item !== null)
  } catch {
    return []
  }
}

export function writeCharacters(taskId: string, characters: Character[]) {
  if (!taskId) return
  try {
    const library: CharacterLibrary = { version: 1, taskId, updatedAt: Date.now(), characters }
    window.localStorage.setItem(charactersStorageKey(taskId), JSON.stringify(library))
  } catch {
    // 忽略写入失败（配额满等）
  }
}

export function removeCharacters(taskId: string) {
  if (!taskId) return
  try {
    window.localStorage.removeItem(charactersStorageKey(taskId))
  } catch {
    // ignore
  }
}
