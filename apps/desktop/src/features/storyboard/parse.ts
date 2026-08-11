import type { ShotCard } from './types'

// 收集候选 JSON 片段，按可信度排序：```json 围栏 > 普通围栏 > 整段文本 > {…} 切片 > […] 切片
function jsonCandidates(text: string): string[] {
  const candidates: string[] = []
  if (!text) return candidates

  const jsonFences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (jsonFences.length) {
    const last = jsonFences[jsonFences.length - 1][1]
    if (last?.trim()) candidates.push(last.trim())
  }

  const anyFences = [...text.matchAll(/```\s*([\s\S]*?)```/g)]
  if (anyFences.length) {
    const last = anyFences[anyFences.length - 1][1]
    if (last?.trim()) candidates.push(last.trim())
  }

  // 整段文本本身可能就是合法 JSON（裸对象或裸数组）
  candidates.push(text.trim())

  const braceStart = text.indexOf('{')
  const braceEnd = text.lastIndexOf('}')
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1).trim())
  }

  const bracketStart = text.indexOf('[')
  const bracketEnd = text.lastIndexOf(']')
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    candidates.push(text.slice(bracketStart, bracketEnd + 1).trim())
  }

  return candidates
}

function asText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.trim()
  return String(value).trim()
}

type RawShot = { scene?: unknown; dialogue?: unknown; visual?: unknown; characters?: unknown }

function toNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value.map(asText).filter((name) => name.length > 0)
  // 去重（大小写/空格不敏感）
  const seen = new Set<string>()
  const result: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

function toRawShots(parsed: unknown): RawShot[] | null {
  if (Array.isArray(parsed)) return parsed as RawShot[]
  if (parsed && typeof parsed === 'object') {
    const shots = (parsed as { shots?: unknown }).shots
    if (Array.isArray(shots)) return shots as RawShot[]
  }
  return null
}

export function parseShots(text: string, idSeed: number = Date.now()): ShotCard[] | null {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const rawShots = toRawShots(parsed)
    if (!rawShots) continue

    const cards: ShotCard[] = []
    rawShots.forEach((raw, position) => {
      const scene = asText(raw?.scene)
      const dialogue = asText(raw?.dialogue)
      const visualPrompt = asText(raw?.visual)
      // 丢弃完全为空的条目
      if (!scene && !dialogue && !visualPrompt) return
      cards.push({
        id: `shot-${idSeed}-${position}`,
        index: cards.length + 1,
        scene,
        dialogue,
        visualPrompt,
        characterNames: toNameList(raw?.characters),
        imageStatus: 'idle',
      })
    })

    if (cards.length) return cards
  }

  return null
}

export type ExtractedCharacter = { name: string; appearance: string }

type RawCharacter = { name?: unknown; appearance?: unknown }

function toRawCharacters(parsed: unknown): RawCharacter[] | null {
  if (Array.isArray(parsed)) return parsed as RawCharacter[]
  if (parsed && typeof parsed === 'object') {
    const characters = (parsed as { characters?: unknown }).characters
    if (Array.isArray(characters)) return characters as RawCharacter[]
  }
  return null
}

export function parseCharacters(text: string): ExtractedCharacter[] | null {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const rawCharacters = toRawCharacters(parsed)
    if (!rawCharacters) continue

    const result: ExtractedCharacter[] = []
    const seen = new Set<string>()
    rawCharacters.forEach((raw) => {
      const name = asText(raw?.name)
      const appearance = asText(raw?.appearance)
      if (!name) return
      const key = name.toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      result.push({ name, appearance })
    })

    if (result.length) return result
  }

  return null
}
