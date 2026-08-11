import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountUser, CodexTask, RuntimeAttachment } from '@eaw/shared'
import { runtimeEndpoint } from '../../api'
import type { ExecutionSettings } from '../../config'
import { getRuntimeTask } from '../runtime/client'
import { generateShotImage, requestCharacterExtraction, requestStoryboardBreakdown, uploadMaskedImage } from './client'
import { parseCharacters, parseShots } from './parse'
import { readStoryboard, writeStoryboard } from './storage'
import { readCharacters, writeCharacters, type Character } from './characters'
import { CHARACTER_SHEET_SUFFIX, REALISTIC_STYLE_PREFIX } from './prompt'
import type { ShotCard, Storyboard, StoryboardStatus } from './types'

const POLL_INTERVAL_MS = 2500
// 后端 image job 上限约 5 分钟，前端略放宽到 6 分钟兜底
const HARD_TIMEOUT_MS = 360_000
// 单镜垫图参考图上限
const MAX_REF_IMAGES = 4

function resolveImageUrl(url?: string) {
  if (!url) return undefined
  if (url.startsWith('/api/')) return runtimeEndpoint(url)
  return url
}

function imageUrlFromTask(task: CodexTask): string | undefined {
  const generated = task.generatedImages?.[0]?.url
  if (generated) return resolveImageUrl(generated)
  const output = (task.outputs ?? []).find((item) => item.type === 'image')
  return resolveImageUrl(output?.url ?? output?.path)
}

const normName = (value: string) => value.trim().toLowerCase()

// 把角色定妆图 URL 构造成 runtime 可用的垫图 attachment
function attachmentFromCharacter(character: Character): RuntimeAttachment | null {
  if (!character.refImageUrl) return null
  return {
    id: `charref-${character.id}`,
    type: 'image',
    name: `${character.name || 'character'}.png`,
    mimeType: 'image/png',
    size: 0,
    storageUrl: character.refImageUrl,
    createdAt: new Date().toISOString(),
  }
}

export function useStoryboard({
  activeTaskId,
  authToken,
  authUser,
  executionSettings,
}: {
  activeTaskId: string
  authToken: string
  authUser: AccountUser | null
  executionSettings: ExecutionSettings
}) {
  const [board, setBoard] = useState<Storyboard | null>(null)
  const [status, setStatus] = useState<StoryboardStatus>('idle')
  const [error, setError] = useState<string>('')
  const [characters, setCharacters] = useState<Character[]>([])
  const [extractStatus, setExtractStatus] = useState<'idle' | 'extracting' | 'error'>('idle')
  const [extractError, setExtractError] = useState<string>('')

  // 关键的会话上下文：用 ref 让长生命周期的轮询闭包总能读到当前 taskId
  const contextTaskIdRef = useRef(activeTaskId)
  contextTaskIdRef.current = activeTaskId

  // 人物库 ref：generateImage 在生成时需读取最新的人物库（含定妆图 URL）
  const charactersRef = useRef<Character[]>([])

  // 跟踪所有进行中的轮询定时器，便于切会话/卸载时统一清理
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  const clearAllTimers = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer))
    timersRef.current.clear()
  }, [])

  // state + ref 同步写入人物库
  const setCharactersSynced = useCallback((next: Character[]) => {
    charactersRef.current = next
    setCharacters(next)
  }, [])

  const persistCharacters = useCallback((taskId: string, next: Character[]) => {
    writeCharacters(taskId, next)
  }, [])

  // 切换会话时：清理轮询、加载该会话的看板与人物库
  useEffect(() => {
    clearAllTimers()
    setStatus('idle')
    setError('')
    setExtractStatus('idle')
    setExtractError('')
    setBoard(readStoryboard(activeTaskId))
    setCharactersSynced(readCharacters(activeTaskId))
  }, [activeTaskId, clearAllTimers, setCharactersSynced])

  // 卸载时清理
  useEffect(() => () => clearAllTimers(), [clearAllTimers])

  const persist = useCallback((next: Storyboard) => {
    writeStoryboard(next)
  }, [])

  // 局部更新某张卡（只在当前上下文会话仍匹配 boardTaskId 时生效）
  const updateCard = useCallback(
    (boardTaskId: string, cardId: string, patch: Partial<ShotCard>) => {
      setBoard((current) => {
        if (!current || current.taskId !== boardTaskId) return current
        const cards = current.cards.map((card) => (card.id === cardId ? { ...card, ...patch } : card))
        const next = { ...current, cards, updatedAt: Date.now() }
        persist(next)
        return next
      })
    },
    [persist],
  )

  // 轮询某个 runtime task 直到终态，回调 onDone/onFail
  // earlyDone: 可选的「提前成功」判定——某些直连任务（如生图）status 会长期停留在
  // running，但结果（图片 URL）其实已经回填，此时凭结果判定成功，不死等 status。
  const pollTask = useCallback(
    (
      taskId: string,
      onDone: (task: CodexTask) => void,
      onFail: (message: string) => void,
      earlyDone?: (task: CodexTask) => boolean,
    ) => {
      const startedAt = Date.now()
      const tick = async () => {
        try {
          const task = await getRuntimeTask(taskId)
          if (!task) {
            onFail('任务不存在')
            return
          }
          if (earlyDone?.(task)) {
            onDone(task)
            return
          }
          if (task.status === 'completed') {
            onDone(task)
            return
          }
          if (task.status === 'failed' || task.status === 'interrupted') {
            onFail(task.status === 'failed' ? '任务失败' : '任务被中断')
            return
          }
          if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
            onFail('超时')
            return
          }
          const timer = setTimeout(tick, POLL_INTERVAL_MS)
          timersRef.current.add(timer)
        } catch (err) {
          onFail(err instanceof Error ? err.message : '轮询出错')
        }
      }
      const timer = setTimeout(tick, POLL_INTERVAL_MS)
      timersRef.current.add(timer)
    },
    [],
  )

  // 发起拆分镜
  const requestBreakdown = useCallback(
    async (script: string) => {
      const text = script.trim()
      if (!text) return
      setStatus('requesting')
      setError('')
      try {
        const task = await requestStoryboardBreakdown({
          script: text,
          authToken,
          authUser,
          executionSettings,
        })
        const boardTaskId = contextTaskIdRef.current
        setStatus('parsing')
        pollTask(
          task.id,
          (done) => {
            const latestAssistant = [...done.transcript].reverse().find((item) => item.role === 'assistant')
            const cards = latestAssistant ? parseShots(latestAssistant.content) : null
            if (!cards) {
              setStatus('error')
              setError('分镜解析失败，可重试或手动新增分镜。')
              return
            }
            const next: Storyboard = {
              taskId: boardTaskId,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              cards,
            }
            setBoard(next)
            persist(next)
            setStatus('ready')
          },
          (message) => {
            setStatus('error')
            setError(`拆分镜失败：${message}`)
          },
        )
      } catch (err) {
        setStatus('error')
        setError(err instanceof Error ? err.message : '拆分镜请求失败')
      }
    },
    [authToken, authUser, executionSettings, persist, pollTask],
  )

  // 逐镜生图
  const generateImage = useCallback(
    async (cardId: string) => {
      const boardTaskId = contextTaskIdRef.current
      const card = board?.cards.find((item) => item.id === cardId)
      if (!card || !card.visualPrompt.trim()) {
        updateCard(boardTaskId, cardId, { imageStatus: 'error', imageError: '画面描述为空' })
        return
      }
      updateCard(boardTaskId, cardId, { imageStatus: 'generating', imageError: undefined })
      try {
        // 垫图解析：把该镜关联的、且已有定妆图的角色作为参考图传入
        const wanted = new Set(card.characterNames.map(normName))
        const matched = wanted.size
          ? charactersRef.current.filter((c) => wanted.has(normName(c.name)) && c.refImageUrl)
          : []
        const attachments = matched
          .slice(0, MAX_REF_IMAGES)
          .map(attachmentFromCharacter)
          .filter((item): item is RuntimeAttachment => item !== null)
        // 有关联角色但都没有定妆图 → 退化为文生图，给出软提示
        const noRefHint = card.characterNames.length > 0 && attachments.length === 0
          ? '关联角色尚无定妆图，本次未垫图'
          : undefined

        const imageTaskId = await generateShotImage({
          prompt: `${REALISTIC_STYLE_PREFIX}${card.visualPrompt.trim()}`,
          authToken,
          authUser,
          attachments,
        })
        updateCard(boardTaskId, cardId, { imageTaskId })
        pollTask(
          imageTaskId,
          (done) => {
            const url = imageUrlFromTask(done)
            if (!url) {
              updateCard(boardTaskId, cardId, { imageStatus: 'error', imageError: '未取到图片地址' })
              return
            }
            updateCard(boardTaskId, cardId, { imageStatus: 'done', imageUrl: url, imageError: noRefHint })
          },
          (message) => {
            updateCard(boardTaskId, cardId, { imageStatus: 'error', imageError: message })
          },
          // 生图任务 status 可能长期停留在 running，凭是否已产出图片 URL 判定成功
          (task) => Boolean(imageUrlFromTask(task)),
        )
      } catch (err) {
        updateCard(boardTaskId, cardId, {
          imageStatus: 'error',
          imageError: err instanceof Error ? err.message : '生图失败',
        })
      }
    },
    [authToken, authUser, board, pollTask, updateCard],
  )

  // 行内编辑字段
  const editCard = useCallback(
    (cardId: string, patch: Partial<Pick<ShotCard, 'scene' | 'dialogue' | 'visualPrompt'>>) => {
      updateCard(contextTaskIdRef.current, cardId, patch)
    },
    [updateCard],
  )

  // 用遮脸结果替换分镜图：先上传换公网 URL（供视频选用），失败则回退本地 dataURL
  const setShotImage = useCallback(
    async (cardId: string, dataUrl: string) => {
      const boardTaskId = contextTaskIdRef.current
      try {
        const url = await uploadMaskedImage(dataUrl, authToken, `shot-${cardId}-masked.png`)
        updateCard(boardTaskId, cardId, { imageUrl: url, imageStatus: 'done', imageError: undefined })
      } catch (err) {
        updateCard(boardTaskId, cardId, {
          imageUrl: dataUrl,
          imageStatus: 'done',
          imageError: `已替换但上传失败，无法用于视频：${err instanceof Error ? err.message : '上传失败'}`,
        })
      }
    },
    [authToken, updateCard],
  )

  // 手动新增空白分镜
  const addCard = useCallback(() => {
    const boardTaskId = contextTaskIdRef.current
    setBoard((current) => {
      const base: Storyboard =
        current && current.taskId === boardTaskId
          ? current
          : { taskId: boardTaskId, createdAt: Date.now(), updatedAt: Date.now(), cards: [] }
      const newCard: ShotCard = {
        id: `shot-${Date.now()}-${base.cards.length}`,
        index: base.cards.length + 1,
        scene: '',
        dialogue: '',
        visualPrompt: '',
        characterNames: [],
        imageStatus: 'idle',
      }
      const next = { ...base, cards: [...base.cards, newCard], updatedAt: Date.now() }
      persist(next)
      return next
    })
    setStatus('ready')
  }, [persist])

  // 删除分镜
  const removeCard = useCallback(
    (cardId: string) => {
      const boardTaskId = contextTaskIdRef.current
      setBoard((current) => {
        if (!current || current.taskId !== boardTaskId) return current
        const cards = current.cards
          .filter((card) => card.id !== cardId)
          .map((card, position) => ({ ...card, index: position + 1 }))
        const next = { ...current, cards, updatedAt: Date.now() }
        persist(next)
        return next
      })
    },
    [persist],
  )

  // ===== 人物库 =====
  const mutateCharacters = useCallback(
    (mutator: (current: Character[]) => Character[]) => {
      const taskId = contextTaskIdRef.current
      const next = mutator(charactersRef.current)
      setCharactersSynced(next)
      persistCharacters(taskId, next)
    },
    [persistCharacters, setCharactersSynced],
  )

  // 从剧本提取人物，只补充新角色（已存在的同名不动）
  const extractCharacters = useCallback(
    async (script: string) => {
      const text = script.trim()
      if (!text) {
        setExtractStatus('error')
        setExtractError('当前对话没有可提取的剧本内容')
        return
      }
      setExtractStatus('extracting')
      setExtractError('')
      try {
        const task = await requestCharacterExtraction({ script: text, authToken, authUser, executionSettings })
        pollTask(
          task.id,
          (done) => {
            const latestAssistant = [...done.transcript].reverse().find((item) => item.role === 'assistant')
            const extracted = latestAssistant ? parseCharacters(latestAssistant.content) : null
            if (!extracted) {
              setExtractStatus('error')
              setExtractError('人物提取解析失败，可重试或手动新增人物。')
              return
            }
            mutateCharacters((current) => {
              const existing = new Set(current.map((c) => normName(c.name)))
              const additions: Character[] = []
              extracted.forEach((item, idx) => {
                if (existing.has(normName(item.name))) return
                existing.add(normName(item.name))
                additions.push({
                  id: `character-${Date.now()}-${current.length + idx}`,
                  name: item.name,
                  appearance: item.appearance,
                  imageStatus: 'idle',
                })
              })
              return [...current, ...additions]
            })
            setExtractStatus('idle')
          },
          (message) => {
            setExtractStatus('error')
            setExtractError(`人物提取失败：${message}`)
          },
        )
      } catch (err) {
        setExtractStatus('error')
        setExtractError(err instanceof Error ? err.message : '人物提取请求失败')
      }
    },
    [authToken, authUser, executionSettings, mutateCharacters, pollTask],
  )

  const addCharacter = useCallback(() => {
    mutateCharacters((current) => [
      ...current,      {
        id: `character-${Date.now()}-${current.length}`,
        name: '',
        appearance: '',
        imageStatus: 'idle',
      },
    ])
  }, [mutateCharacters])

  const editCharacter = useCallback(
    (id: string, patch: Partial<Pick<Character, 'name' | 'appearance'>>) => {
      mutateCharacters((current) => current.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    },
    [mutateCharacters],
  )

  const removeCharacter = useCallback(
    (id: string) => {
      mutateCharacters((current) => current.filter((c) => c.id !== id))
    },
    [mutateCharacters],
  )

  const updateCharacter = useCallback(
    (id: string, patch: Partial<Character>) => {
      mutateCharacters((current) => current.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    },
    [mutateCharacters],
  )

  // 用遮脸结果替换角色定妆图：先上传换公网 URL，失败则回退本地 dataURL
  const setCharacterImage = useCallback(
    async (id: string, dataUrl: string) => {
      try {
        const url = await uploadMaskedImage(dataUrl, authToken, `character-${id}-masked.png`)
        mutateCharacters((current) =>
          current.map((c) => (c.id === id ? { ...c, refImageUrl: url, imageStatus: 'done', imageError: undefined } : c)),
        )
      } catch (err) {
        mutateCharacters((current) =>
          current.map((c) =>
            c.id === id
              ? { ...c, refImageUrl: dataUrl, imageStatus: 'done', imageError: `已替换但上传失败，无法用于视频：${err instanceof Error ? err.message : '上传失败'}` }
              : c,
          ),
        )
      }
    },
    [authToken, mutateCharacters],
  )

  // 生成角色定妆图（文生图，不垫图）
  const generateCharacterImage = useCallback(
    async (id: string) => {
      const character = charactersRef.current.find((c) => c.id === id)
      if (!character || !character.appearance.trim()) {
        updateCharacter(id, { imageStatus: 'error', imageError: '请先填写人物外貌描述' })
        return
      }
      updateCharacter(id, { imageStatus: 'generating', imageError: undefined })
      try {
        const intro = character.name.trim()
          ? `角色设定表：${character.name.trim()}。${character.appearance.trim()}。`
          : `角色设定表：${character.appearance.trim()}。`
        const prompt = `${REALISTIC_STYLE_PREFIX}${intro}${CHARACTER_SHEET_SUFFIX}`
        const imageTaskId = await generateShotImage({ prompt, authToken, authUser })
        updateCharacter(id, { refImageTaskId: imageTaskId })
        pollTask(
          imageTaskId,
          (done) => {
            const url = imageUrlFromTask(done)
            if (!url) {
              updateCharacter(id, { imageStatus: 'error', imageError: '未取到图片地址' })
              return
            }
            updateCharacter(id, { imageStatus: 'done', refImageUrl: url, imageError: undefined })
          },
          (message) => {
            updateCharacter(id, { imageStatus: 'error', imageError: message })
          },
          (task) => Boolean(imageUrlFromTask(task)),
        )
      } catch (err) {
        updateCharacter(id, {
          imageStatus: 'error',
          imageError: err instanceof Error ? err.message : '定妆图生成失败',
        })
      }
    },
    [authToken, authUser, pollTask, updateCharacter],
  )

  // ===== 镜头-角色关联（手动修正自动关联） =====
  const addCharacterToShot = useCallback(
    (cardId: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const boardTaskId = contextTaskIdRef.current
      setBoard((current) => {
        if (!current || current.taskId !== boardTaskId) return current
        const cards = current.cards.map((card) => {
          if (card.id !== cardId) return card
          if (card.characterNames.some((n) => normName(n) === normName(trimmed))) return card
          return { ...card, characterNames: [...card.characterNames, trimmed] }
        })
        const next = { ...current, cards, updatedAt: Date.now() }
        persist(next)
        return next
      })
    },
    [persist],
  )

  const removeCharacterFromShot = useCallback(
    (cardId: string, name: string) => {
      const boardTaskId = contextTaskIdRef.current
      setBoard((current) => {
        if (!current || current.taskId !== boardTaskId) return current
        const cards = current.cards.map((card) =>
          card.id === cardId
            ? { ...card, characterNames: card.characterNames.filter((n) => normName(n) !== normName(name)) }
            : card,
        )
        const next = { ...current, cards, updatedAt: Date.now() }
        persist(next)
        return next
      })
    },
    [persist],
  )

  return {
    board,
    status,
    error,
    characters,
    extractStatus,
    extractError,
    requestBreakdown,
    generateImage,
    editCard,
    setShotImage,
    addCard,
    removeCard,
    addCharacter,
    editCharacter,
    removeCharacter,
    generateCharacterImage,
    setCharacterImage,
    extractCharacters,
    addCharacterToShot,
    removeCharacterFromShot,
  }
}
