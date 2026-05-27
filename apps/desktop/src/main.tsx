import { Bot, Box, Check, ChevronDown, Circle, FolderOpen, Loader2, Plus, Search, Send, Settings, UserRound } from 'lucide-react'
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { CodexTask, CodexTaskEvent } from '@eaw/shared'
import '@fontsource-variable/geist'
import '@fontsource-variable/noto-sans-sc'
import './styles.css'

const launchParams = new URLSearchParams(window.location.search)
const runtimeUrl = launchParams.get('runtimeUrl') ?? import.meta.env.VITE_CODEX_RUNTIME_URL ?? 'http://127.0.0.1:4101'
const runtimeToken = launchParams.get('runtimeToken') ?? import.meta.env.VITE_CODEX_RUNTIME_TOKEN ?? ''
const defaultWorkspace = import.meta.env.VITE_DEFAULT_WORKSPACE ?? '/Users/a1/Documents/Codex/2026-05-26/codex'
const localEmployeeId = import.meta.env.VITE_EMPLOYEE_ID ?? 'u-1001'

type TranscriptItem = CodexTask['transcript'][number]
type RuntimeState = 'checking' | 'online' | 'offline'

const welcomeTask: CodexTask = {
  id: 'welcome',
  title: '新任务',
  status: 'completed',
  workspace: defaultWorkspace,
  transcript: [
  ],
}

function nowIso() {
  return new Date().toISOString()
}

function statusText(status: CodexTask['status']) {
  return {
    queued: '排队',
    running: '运行中',
    needs_approval: '待确认',
    completed: '完成',
    failed: '失败',
  }[status]
}

function taskSortValue(task: CodexTask) {
  return new Date(task.createdAt ?? task.transcript[0]?.timestamp ?? 0).getTime()
}

function normalizeTask(task: CodexTask): CodexTask {
  const transcript = compactTranscript((task.transcript ?? []).filter(shouldShowMessage))
  const title = task.title?.trim().replace(/^生成图片[:：]\s*/, '')
  const hasVisibleReply = transcript.some((item) => item.role !== 'user')

  if (task.status === 'failed' && !hasVisibleReply) {
    transcript.push({
      role: 'system',
      content: '模型服务暂时不可用，请检查模型密钥或稍后重试。',
      timestamp: task.updatedAt ?? nowIso(),
    })
  }

  return {
    ...task,
    title: title || transcript.find((item) => item.role === 'user')?.content.slice(0, 36) || '新任务',
    transcript,
  }
}

function compactTranscript(items: TranscriptItem[]) {
  return items.reduce<TranscriptItem[]>((merged, item) => {
    const previous = merged.at(-1)
    if (previous?.role === 'assistant' && item.role === 'assistant') {
      if (item.content.startsWith(previous.content)) {
        merged[merged.length - 1] = item
        return merged
      }
      if (previous.content.startsWith(item.content)) return merged
    }
    if (previous?.role === 'user' && item.role === 'user' && previous.content === item.content) return merged
    merged.push(item)
    return merged
  }, [])
}

function eventToTranscript(event: CodexTaskEvent) {
  return {
    role: event.role,
    content: event.content,
    timestamp: event.timestamp,
  }
}

function mergeTask(tasks: CodexTask[], next: CodexTask) {
  const normalized = normalizeTask(next)
  const withoutWelcome = tasks.filter((task) => task.id !== 'welcome')
  const exists = withoutWelcome.some((task) => task.id === normalized.id)
  const merged = exists
    ? withoutWelcome.map((task) => (task.id === normalized.id ? normalized : task))
    : [normalized, ...withoutWelcome]

  return merged.sort((a, b) => taskSortValue(b) - taskSortValue(a))
}

function replaceTask(tasks: CodexTask[], oldTaskId: string, next: CodexTask) {
  return mergeTask(
    tasks.filter((task) => task.id !== oldTaskId),
    next,
  )
}

function shouldShowMessage(item: TranscriptItem) {
  const content = item.content.trim()
  if (!content) return false
  if (/^正在生成图片[.。…]*$/.test(content)) return false
  if (/^Codex\s*任务退出，代码/.test(content)) return false
  if (/Missing environment variable:|invalid api key|403 Forbidden/i.test(content)) return false
  if (isInternalCodexJson(content)) return false
  if (item.role !== 'system') return true
  return (
    content.includes('Codex Runtime 没连上') ||
    content.includes('任务创建失败') ||
    content.includes('发送失败') ||
    content.includes('中断') ||
    content.includes('退出') ||
    content.includes('失败') ||
    content.includes('错误') ||
    content.includes('未配置') ||
    content.includes('超时') ||
    content.includes('不支持') ||
    content.includes('不可用') ||
    content.includes('密钥') ||
    content.includes('error')
  )
}

function isInternalCodexJson(content: string) {
  if (!content.startsWith('{') || !content.endsWith('}')) return false

  try {
    const payload = JSON.parse(content) as { type?: unknown; item?: { type?: unknown } }
    const type = typeof payload.type === 'string' ? payload.type : ''
    const itemType = payload.item && typeof payload.item.type === 'string' ? payload.item.type : ''

    return (
      type.startsWith('item.') ||
      type.startsWith('turn.') ||
      type.includes('delta') ||
      itemType === 'web_search' ||
      itemType === 'reasoning' ||
      itemType === 'command_execution'
    )
  } catch {
    return content.includes('"type":"item.') || content.includes('"type":"web_search"')
  }
}

function messageLabel(role: TranscriptItem['role']) {
  return {
    assistant: '墨渊',
    tool: '命令',
    system: '系统',
    user: '你',
  }[role]
}

function taskMeta(task: CodexTask) {
  const assistantTurns = task.transcript.filter((item) => item.role === 'assistant').length
  const commandTurns = task.transcript.filter((item) => item.role === 'tool' && item.content.trim().startsWith('$')).length
  if (task.generatedImages?.length) return `${task.generatedImages.length} 张图片`
  if (task.sessionId) return `${assistantTurns} 轮 · 可续聊`
  if (commandTurns) return `${commandTurns} 次命令`
  return statusText(task.status)
}

function eventStatus(event: CodexTaskEvent, fallback: CodexTask['status']): CodexTask['status'] {
  if (event.type === 'process.exit') return event.content.includes('完成') ? 'completed' : 'failed'
  if (event.type === 'turn.failed' || event.type === 'error') return 'failed'
  if (event.type === 'turn.completed') return 'completed'
  if (event.type === 'turn.started' || event.type === 'thread.started' || event.type === 'tool') return 'running'
  return fallback
}

function mergeEventIntoTask(task: CodexTask, event: CodexTaskEvent): CodexTask {
  const transcriptItem = eventToTranscript(event)
  if (!shouldShowMessage(transcriptItem)) {
    const nextStatus = eventStatus(event, task.status)
    const hasVisibleReply = task.transcript.some((item) => item.role !== 'user')
    if (nextStatus === 'failed' && !hasVisibleReply) {
      return {
        ...task,
        status: nextStatus,
        transcript: [
          ...task.transcript,
          {
            role: 'system',
            content: '模型服务暂时不可用，请检查模型密钥或稍后重试。',
            timestamp: event.timestamp,
          },
        ],
      }
    }
    return { ...task, status: nextStatus }
  }

  if (event.type === 'message_delta' && event.role === 'assistant') {
    const transcript = [...task.transcript]
    const lastIndex = transcript.length - 1
    const lastItem = transcript[lastIndex]

    if (lastItem?.role !== 'assistant') {
      transcript.push(transcriptItem)
    } else {
      const current = lastItem
      const content = event.content.startsWith(current.content) ? event.content : `${current.content}${event.content}`
      transcript[lastIndex] = { ...current, content, timestamp: event.timestamp }
    }
    return { ...task, status: eventStatus(event, task.status), transcript }
  }

  if (event.type === 'message' && event.role === 'assistant' && task.transcript.at(-1)?.role === 'assistant') {
    const last = task.transcript.at(-1)
    if (last?.content === event.content || event.content.startsWith(last?.content ?? '')) {
      return {
        ...task,
        status: eventStatus(event, task.status),
        transcript: [...task.transcript.slice(0, -1), transcriptItem],
      }
    }
  }

  const seen = task.transcript.some((item) => item.timestamp === event.timestamp && item.content === event.content && item.role === event.role)
  const transcript = seen ? task.transcript : [...task.transcript, transcriptItem]
  return { ...task, status: eventStatus(event, task.status), transcript }
}

function hasCodexActivity(task: CodexTask) {
  return task.transcript.some((item) => (item.role === 'assistant' || item.role === 'tool') && item.content.trim())
}

function buildPendingTask(promptText: string, workspacePath: string): CodexTask {
  const timestamp = nowIso()
  return {
    id: `pending-${Date.now()}`,
    title: promptText.slice(0, 36),
    status: 'queued',
    workspace: workspacePath,
    createdAt: timestamp,
    exitCode: null,
    transcript: [
      {
        role: 'user',
        content: promptText,
        timestamp,
      },
    ],
  }
}

function appendPendingTurn(task: CodexTask, promptText: string, workspacePath: string): CodexTask {
  return {
    ...task,
    status: 'queued',
    workspace: workspacePath,
    transcript: [
      ...task.transcript,
      {
        role: 'user',
        content: promptText,
        timestamp: nowIso(),
      },
    ],
  }
}

function buildLocalErrorTask(error: unknown, workspacePath: string): CodexTask {
  const timestamp = nowIso()
  return {
    id: `error-${Date.now()}`,
    title: '发送失败',
    status: 'failed',
    workspace: workspacePath,
    createdAt: timestamp,
    exitCode: null,
    transcript: [
      {
        role: 'system',
        content: `发送失败：${toUserFacingError(error)}`,
        timestamp,
      },
    ],
  }
}

function toUserFacingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/OPENAI_API_KEY|AI_API_KEY|IMAGE_API_KEY|invalid api key|403 Forbidden|Missing environment variable/i.test(message)) {
    return '模型服务暂时不可用，请检查模型密钥或稍后重试。'
  }
  if (/Failed to fetch|NetworkError|offline|ECONNREFUSED|fetch failed/i.test(message)) {
    return '本地服务暂时没连上，我会继续尝试恢复。'
  }
  return '任务没有正常完成，请稍后再试。'
}

function isCommandToolContent(content: string) {
  return content.trimStart().startsWith('$')
}

function TranscriptMessage({ animate, item, label }: { animate: boolean; item: TranscriptItem; label: string }) {
  const [visibleText, setVisibleText] = useState(animate && item.role === 'assistant' ? '' : item.content)
  const visibleTextRef = useRef(visibleText)
  const isToolStatus = item.role === 'tool' && !isCommandToolContent(item.content)
  const effectiveLabel = isToolStatus ? '状态' : label

  useEffect(() => {
    visibleTextRef.current = visibleText
  }, [visibleText])

  useEffect(() => {
    if (!animate || item.role !== 'assistant') {
      setVisibleText(item.content)
      return
    }

    let index = item.content.startsWith(visibleTextRef.current) ? visibleTextRef.current.length : 0
    if (index === 0) setVisibleText('')

    const step = () => {
      index = Math.min(item.content.length, index + Math.max(1, Math.ceil(item.content.length / 80)))
      const next = item.content.slice(0, index)
      visibleTextRef.current = next
      setVisibleText(next)
      window.dispatchEvent(new Event('moyuan:content-resized'))
      if (index >= item.content.length) window.clearInterval(timer)
    }
    const timer = window.setInterval(step, 18)
    step()

    return () => window.clearInterval(timer)
  }, [animate, item.content, item.role])

  return (
    <article className={`message ${item.role} ${isToolStatus ? 'tool-status' : ''}`}>
      <div className="message-label" aria-label={effectiveLabel} title={effectiveLabel}>
        {item.role === 'assistant' ? (
          <Bot size={17} />
        ) : item.role === 'tool' ? (
          isToolStatus ? (
            <span className="tool-status-dot" />
          ) : (
            <span className="tool-command-dot" />
          )
        ) : item.role === 'system' ? (
          <Circle size={13} />
        ) : (
          '你'
        )}
      </div>
      <div className="message-body">
        {item.role === 'assistant' ? <MarkdownText content={visibleText} /> : item.role === 'tool' ? <ToolOutput content={visibleText} /> : visibleText}
        {animate && item.role === 'assistant' && visibleText.length < item.content.length ? <span className="stream-caret" /> : null}
      </div>
    </article>
  )
}

function ToolOutput({ content }: { content: string }) {
  const [firstLine, ...rest] = content.split(/\r?\n/)
  const isCommand = isCommandToolContent(firstLine ?? '')
  const command = isCommand ? firstLine?.replace(/^\$\s*/, '').trim() : ''
  const detail = rest.join('\n').trim()
  const summary = command ? `命令` : firstLine?.trim() || '工具调用'

  if (!detail) {
    if (!isCommand) {
      return <div className="tool-status-row">{summary}</div>
    }

    return (
      <div className="tool-row">
        <span className="tool-summary-dot" />
        <span>{summary}</span>
        {command ? <code>{command}</code> : null}
      </div>
    )
  }

  return (
    <details className="tool-output">
      <summary>
        <span className="tool-summary-dot" />
        <span>{summary}</span>
        {command ? <code>{command}</code> : null}
      </summary>
      <pre>{detail}</pre>
    </details>
  )
}

function MarkdownText({ content }: { content: string }) {
  const blocks = useMemo(() => markdownBlocks(content), [content])

  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          const listProps = block.ordered && block.start ? { start: block.start } : {}
          return <ListTag {...listProps} key={index}>{block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <div>{renderInline(item.body)}</div>
              {item.meta ? <div className="list-meta">{renderInline(item.meta)}</div> : null}
            </li>
          ))}</ListTag>
        }

        if (block.type === 'heading') {
          return <h3 key={index}>{renderInline(block.text)}</h3>
        }

        if (block.type === 'code') {
          return (
            <pre className="code-block" key={index}>
              <code>{block.code}</code>
            </pre>
          )
        }

        if (block.type === 'quote') {
          return <blockquote key={index}>{renderInline(block.text)}</blockquote>
        }

        if (block.type === 'image') {
          return (
            <figure className="image-result" key={index}>
              <img alt={block.alt} onLoad={() => window.dispatchEvent(new Event('moyuan:content-resized'))} src={resolveRuntimeAssetUrl(block.src)} />
            </figure>
          )
        }

        return <p key={index}>{renderInline(block.text)}</p>
      })}
    </div>
  )
}

type MarkdownBlock =
  | { type: 'paragraph' | 'heading' | 'quote'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'image'; alt: string; src: string }
  | { type: 'list'; ordered: boolean; start?: number; items: Array<{ body: string; meta?: string }> }

function resolveRuntimeAssetUrl(src: string) {
  if (src.startsWith('/api/')) return runtimeEndpoint(src)
  return src
}

function runtimeEndpoint(pathname: string) {
  const url = new URL(pathname, runtimeUrl)
  if (runtimeToken) url.searchParams.set('token', runtimeToken)
  return url.toString()
}

function runtimeFetch(pathname: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (runtimeToken) headers.set('x-moyuan-runtime-token', runtimeToken)
  return fetch(runtimeEndpoint(pathname), { ...init, headers })
}

function markdownBlocks(content: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = content.split(/\r?\n/)
  let paragraph: string[] = []
  let list: { ordered: boolean; start?: number; items: Array<{ body: string; meta?: string }> } | null = null
  let codeLines: string[] | null = null
  let codeLanguage = ''

  const flushParagraph = () => {
    if (!paragraph.length) return
    const text = paragraph.join(' ').trim()
    if (text) blocks.push({ type: 'paragraph', text })
    paragraph = []
  }

  const flushList = () => {
    if (!list?.items.length) return
    blocks.push({ type: 'list', ordered: list.ordered, start: list.start, items: list.items })
    list = null
  }

  const flushCode = () => {
    if (!codeLines) return
    blocks.push({ type: 'code', code: codeLines.join('\n'), language: codeLanguage })
    codeLines = null
    codeLanguage = ''
  }

  for (const rawLine of lines) {
    const fenceMatch = rawLine.match(/^```([A-Za-z0-9_-]*)\s*$/)
    if (codeLines) {
      if (fenceMatch) {
        flushCode()
      } else {
        codeLines.push(rawLine)
      }
      continue
    }
    if (fenceMatch) {
      flushParagraph()
      flushList()
      codeLines = []
      codeLanguage = fenceMatch[1] ?? ''
      continue
    }

    const line = rawLine.trim()
    if (!line) {
      flushParagraph()
      continue
    }

    const unorderedListMatch = line.match(/^[-*]\s+(.+)$/)
    const orderedListMatch = line.match(/^(\d+)[.)]\s+(.+)$/)
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (imageMatch) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'image', alt: imageMatch[1], src: imageMatch[2] })
      continue
    }

    if (unorderedListMatch || orderedListMatch) {
      flushParagraph()
      const ordered = Boolean(orderedListMatch)
      const start = orderedListMatch ? Number(orderedListMatch[1]) : undefined
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, start, items: [] }
      list.items.push({ body: unorderedListMatch ? unorderedListMatch[1] : orderedListMatch![2] })
      continue
    }

    if (list?.items.length && /^https?:\/\//.test(line)) {
      list.items[list.items.length - 1] = { ...list.items[list.items.length - 1], meta: line }
      continue
    }

    const quoteMatch = line.match(/^>\s+(.+)$/)
    if (quoteMatch) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'quote', text: quoteMatch[1] })
      continue
    }

    const headingMatch = line.match(/^\*\*(.+)\*\*[:：]?$/)
    if (headingMatch) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', text: headingMatch[1] })
      continue
    }

    flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  flushCode()

  return blocks.length ? blocks : [{ type: 'paragraph', text: content }]
}

function renderInline(text: string) {
  const nodes: React.ReactNode[] = []
  const pattern = /(\*\*([^*]+?)\*\*)|(https?:\/\/[^\s)]+)|(`([^`]+?)`)/g
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    if (match[2]) {
      nodes.push(<strong key={nodes.length}>{match[2]}</strong>)
    } else if (match[3]) {
      nodes.push(
        <a href={match[3]} key={nodes.length} rel="noreferrer" target="_blank">
          {match[3]}
        </a>,
      )
    } else if (match[5]) {
      nodes.push(<code key={nodes.length}>{match[5]}</code>)
    }
    cursor = pattern.lastIndex
  }

  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

function DesktopApp() {
  const [tasks, setTasks] = useState<CodexTask[]>([welcomeTask])
  const [activeTaskId, setActiveTaskId] = useState(welcomeTask.id)
  const [draftByTaskId, setDraftByTaskId] = useState<Record<string, string>>({})
  const workspace = defaultWorkspace
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('checking')
  const mainPaneRef = useRef<HTMLElement | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const seenEventsRef = useRef<Set<string>>(new Set())
  const previousTaskIdRef = useRef(activeTaskId)
  const pinTranscriptToBottomRef = useRef(true)

  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) ?? tasks[0], [activeTaskId, tasks])
  const visibleTranscript = useMemo(() => activeTask.transcript.filter(shouldShowMessage), [activeTask.transcript])
  const isWelcome = activeTask.id === 'welcome'
  const isBusy = activeTask.status === 'queued' || activeTask.status === 'running'
  const latestVisibleItem = visibleTranscript.at(-1)
  const shouldShowThinking = isBusy && latestVisibleItem?.role !== 'assistant'
  const prompt = draftByTaskId[activeTask.id] ?? ''
  const placeholder = isBusy ? '当前任务运行中，完成后继续发送' : '让墨渊做点什么...'
  const canSubmit = !isSubmitting && !isBusy && Boolean(prompt.trim())
  const showStatusBadge = !isWelcome && (activeTask.status !== 'completed' || runtimeState === 'offline')

  function setPrompt(value: string, taskId = activeTask.id) {
    setDraftByTaskId((current) => ({ ...current, [taskId]: value }))
  }

  function selectTask(taskId: string) {
    pinTranscriptToBottomRef.current = true
    setActiveTaskId(taskId)
    window.requestAnimationFrame(() => {
      scheduleTranscriptBottom('auto')
      textareaRef.current?.focus()
    })
  }

  function isNearTranscriptBottom() {
    const transcript = transcriptRef.current
    if (!transcript) return true
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96
  }

  function scrollTranscriptToBottom(behavior: ScrollBehavior = 'auto') {
    const transcript = transcriptRef.current
    if (!transcript) return
    transcriptBottomRef.current?.scrollIntoView({ block: 'end', behavior })
    transcript.scrollTop = transcript.scrollHeight
  }

  function scheduleTranscriptBottom(behavior: ScrollBehavior = 'auto') {
    const run = () => scrollTranscriptToBottom(behavior)
    run()
    window.requestAnimationFrame(() => {
      run()
      window.requestAnimationFrame(run)
    })
    window.setTimeout(run, 80)
    window.setTimeout(run, 220)
  }

  useEffect(() => {
    runtimeFetch('/health')
      .then((response) => {
        if (!response.ok) throw new Error('offline')
        setRuntimeState('online')
      })
      .catch(() => setRuntimeState('offline'))

    runtimeFetch('/api/codex/tasks')
      .then((response) => response.json())
      .then((payload: { data?: CodexTask[] }) => {
        setRuntimeState('online')
        if (payload.data?.length) {
          const nextTasks = payload.data.map(normalizeTask).sort((a, b) => taskSortValue(b) - taskSortValue(a))
          setTasks(nextTasks)
          setActiveTaskId((current) => (current === welcomeTask.id ? nextTasks[0]?.id ?? current : current))
        }
      })
      .catch(() => {
        setRuntimeState('offline')
        setTasks([
          {
            ...welcomeTask,
            transcript: [
              ...welcomeTask.transcript,
              {
                role: 'system',
                content: `Codex Runtime 没连上：${runtimeUrl}`,
                timestamp: nowIso(),
              },
            ],
          },
        ])
      })
  }, [])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return

    const onScroll = () => {
      pinTranscriptToBottomRef.current = isNearTranscriptBottom()
    }
    transcript.addEventListener('scroll', onScroll, { passive: true })
    return () => transcript.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const switchedTask = previousTaskIdRef.current !== activeTask?.id
    previousTaskIdRef.current = activeTask?.id ?? previousTaskIdRef.current

    if (switchedTask) {
      pinTranscriptToBottomRef.current = true
      scheduleTranscriptBottom('auto')
      void document.fonts?.ready.then(() => scheduleTranscriptBottom('auto'))
      return
    }

    if (pinTranscriptToBottomRef.current) {
      scheduleTranscriptBottom('smooth')
    }
  }, [visibleTranscript.length, activeTask?.id, activeTask?.status])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (!transcript) return

    const keepBottom = () => {
      if (pinTranscriptToBottomRef.current) scheduleTranscriptBottom('auto')
    }
    const observer = new MutationObserver(keepBottom)
    const resizeObserver = new ResizeObserver(keepBottom)
    observer.observe(transcript, { childList: true, characterData: true, subtree: true })
    resizeObserver.observe(transcript)
    for (const child of Array.from(transcript.children)) resizeObserver.observe(child)
    window.addEventListener('moyuan:content-resized', keepBottom)

    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('moyuan:content-resized', keepBottom)
    }
  }, [activeTask?.id, visibleTranscript.length])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const compactHeight = prompt.trim() ? Math.max(34, textarea.scrollHeight) : 34
    textarea.style.height = `${Math.min(118, compactHeight)}px`
    window.dispatchEvent(new Event('moyuan:composer-resized'))
  }, [prompt, activeTask?.id])

  useLayoutEffect(() => {
    const pane = mainPaneRef.current
    const composer = composerRef.current
    if (!pane || !composer) return

    const updateComposerSpace = () => {
      pane.style.setProperty('--composer-space', `${Math.ceil(composer.offsetHeight + 72)}px`)
      if (pinTranscriptToBottomRef.current) scheduleTranscriptBottom('auto')
    }

    updateComposerSpace()
    const observer = new ResizeObserver(updateComposerSpace)
    observer.observe(composer)
    window.addEventListener('resize', updateComposerSpace)
    window.addEventListener('moyuan:composer-resized', updateComposerSpace)
    void document.fonts?.ready.then(updateComposerSpace)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateComposerSpace)
      window.removeEventListener('moyuan:composer-resized', updateComposerSpace)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isEditing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setPrompt('', welcomeTask.id)
        selectTask(welcomeTask.id)
      }

      if (!isEditing && event.key === '/') {
        event.preventDefault()
        textareaRef.current?.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!activeTask || activeTask.id === 'welcome') return

    let pollTimer: number | undefined
    const source = new EventSource(runtimeEndpoint(`/api/codex/tasks/${activeTask.id}/events`))

    source.onmessage = (message) => {
      let event: CodexTaskEvent
      try {
        event = JSON.parse(message.data) as CodexTaskEvent
      } catch {
        return
      }
      if (seenEventsRef.current.has(event.id)) return
      seenEventsRef.current.add(event.id)
      setRuntimeState('online')
      setTasks((current) =>
        current.map((task) => (task.id === event.taskId ? mergeEventIntoTask(task, event) : task)),
      )
    }

    source.onerror = () => {
      source.close()
    }

    pollTimer = window.setInterval(() => {
      runtimeFetch(`/api/codex/tasks/${activeTask.id}`)
        .then((response) => response.json())
        .then((payload: { data?: CodexTask }) => {
          setRuntimeState('online')
          if (payload.data) setTasks((current) => mergeTask(current, payload.data!))
        })
        .catch(() => setRuntimeState('offline'))
    }, 1200)

    return () => {
      source.close()
      if (pollTimer) window.clearInterval(pollTimer)
    }
  }, [activeTask?.id])

  async function submitTask() {
    const promptText = prompt.trim()
    const workspacePath = workspace.trim() || defaultWorkspace
    if (!promptText || isSubmitting) return

    setIsSubmitting(true)
    pinTranscriptToBottomRef.current = true
    const shouldResume = activeTask.id !== 'welcome' && Boolean(activeTask.sessionId)
    const pendingTask = shouldResume ? appendPendingTurn(activeTask, promptText, workspacePath) : buildPendingTask(promptText, workspacePath)
    setTasks((current) => mergeTask(current, pendingTask))
    setActiveTaskId(pendingTask.id)
    setPrompt('')

    try {
      const response = await runtimeFetch('/api/codex/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: localEmployeeId,
          workspace: workspacePath,
          prompt: promptText,
          parentTaskId: shouldResume ? activeTask.id : undefined,
          sessionId: shouldResume ? activeTask.sessionId : undefined,
        }),
      })
      const payload = (await response.json()) as { data?: CodexTask; error?: string }
      if (!response.ok) throw new Error(payload.error ?? `Runtime 返回 ${response.status}`)
      if (!payload.data) throw new Error(payload.error ?? '任务创建失败')
      setRuntimeState('online')
      setTasks((current) => (shouldResume ? mergeTask(current, payload.data!) : replaceTask(current, pendingTask.id, payload.data!)))
      setActiveTaskId(payload.data.id)
    } catch (error) {
      setRuntimeState('offline')
      const errorTask = buildLocalErrorTask(error, workspacePath)
      setTasks((current) => (shouldResume ? mergeTask(current, errorTask) : replaceTask(current, pendingTask.id, errorTask)))
      setActiveTaskId(shouldResume ? activeTask.id : errorTask.id)
    } finally {
      setIsSubmitting(false)
      window.requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  return (
    <main className="desktop-shell">
      <aside className="sidebar">
        <div className="brand">
          <Bot size={18} />
          <strong>墨渊</strong>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          <button
            className={isWelcome ? 'nav-item active' : 'nav-item'}
            onClick={() => {
              setPrompt('', welcomeTask.id)
              selectTask(welcomeTask.id)
            }}
          >
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
            <button
              className={`task-item ${task.status} ${task.id === activeTask.id ? 'active' : ''}`}
              key={task.id}
              onClick={() => selectTask(task.id)}
            >
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

      <section className="main-pane" ref={mainPaneRef}>
        <header className={`topbar ${isWelcome ? 'welcome' : ''}`}>
          <div className="topbar-title">
            {!isWelcome && (
              <>
                <h1>{activeTask.title}</h1>
              </>
            )}
          </div>
          <div className="topbar-actions">
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
          </div>
        </header>

        <div className={`transcript ${isWelcome ? 'welcome' : ''}`} ref={transcriptRef}>
          {visibleTranscript.map((item, index) => {
            const isLatestAssistant = item.role === 'assistant' && index === visibleTranscript.length - 1 && activeTask.status === 'running'
            return <TranscriptMessage animate={isLatestAssistant} item={item} key={`${activeTask.id}-${index}-${item.role}`} label={messageLabel(item.role)} />
          })}
          {shouldShowThinking && (
            <article className="message assistant pending">
              <div className="message-label">
                <Bot size={17} />
              </div>
              <div className="message-body">
                <span className="typing-dot" />
                思考中...
              </div>
            </article>
          )}
          <div className="transcript-bottom" ref={transcriptBottomRef} />
        </div>

        <footer className={`composer ${prompt.trim() ? 'has-text' : 'is-empty'}`} ref={composerRef}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitTask()
              }
            }}
            placeholder={placeholder}
          />
          <div className="composer-toolbar">
            <div className="composer-tools">
              <button className="composer-icon-button" title="添加上下文" type="button">
                <Plus size={16} />
              </button>
              <button className="composer-soft-button" title="自定义" type="button">
                <Settings size={15} />
                <span>自定义</span>
              </button>
            </div>
            <div className="composer-tools right">
              <button className="composer-model-button" title="模型" type="button">
                <span>gpt-5.5</span>
                <ChevronDown size={14} />
              </button>
              <button className="composer-soft-button compact" title="推理强度" type="button">
                medium
              </button>
              <button className="send-button" disabled={!canSubmit} onClick={submitTask} title="发送" type="button">
                {isSubmitting ? <Loader2 size={16} className="spin" /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </footer>
      </section>
    </main>
  )
}

const rootElement = document.getElementById('root')!
const windowWithRoot = window as typeof window & { __moyuanRoot?: ReactDOM.Root }
const root = windowWithRoot.__moyuanRoot ?? ReactDOM.createRoot(rootElement)
windowWithRoot.__moyuanRoot = root

root.render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
)
