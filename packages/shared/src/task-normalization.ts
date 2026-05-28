import type { CodexTask } from './index.js'

export type CodexTranscriptItem = CodexTask['transcript'][number]

function sharedPrefixSuffixLength(left: string, right: string) {
  const maxLength = Math.min(left.length, right.length)
  for (let length = maxLength; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length
  }
  return 0
}

export function mergeAssistantContent(current: string, incoming: string) {
  if (!current) return incoming
  if (!incoming) return current
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  const overlap = sharedPrefixSuffixLength(current, incoming)
  return `${current}${incoming.slice(overlap)}`
}

export function finalAssistantContent(current: string, incoming: string) {
  if (!current) return incoming
  if (!incoming) return current
  if (current === incoming) return current
  if (incoming.startsWith(current)) return incoming
  if (current.startsWith(incoming)) return current

  const sameOpening = current.slice(0, 8) === incoming.slice(0, 8)
  const similarLength = incoming.length >= current.length * 0.6
  if (sameOpening && similarLength) return incoming

  return mergeAssistantContent(current, incoming)
}

export function compactAssistantTranscript<T extends CodexTranscriptItem>(items: T[]) {
  return items.reduce<T[]>((merged, item) => {
    const previous = merged.at(-1)
    if (previous?.role === 'assistant' && item.role === 'assistant') {
      if (previous.itemId && item.itemId && previous.itemId === item.itemId) {
        merged[merged.length - 1] = {
          ...item,
          content: mergeAssistantContent(previous.content, item.content),
        }
        return merged
      }
      if (item.content.startsWith(previous.content)) {
        merged[merged.length - 1] = { ...item, content: mergeAssistantContent(previous.content, item.content) }
        return merged
      }
      if (previous.content.startsWith(item.content)) return merged
    }
    merged.push(item)
    return merged
  }, [])
}

export function isRuntimeFailureNotice(content: string) {
  const text = content.trim()
  const codexRuntimeFailure =
    /(Codex app-server|Codex Runtime).*(退出|断开|失败|错误|超时|没有返回|没有正常|未启动|没连上|请求超时)/i.test(text) ||
    /(退出|断开|失败|错误|超时|没有返回|没有正常|未启动|没连上|请求超时).*(Codex app-server|Codex Runtime)/i.test(text)

  return (
    text.startsWith('失败诊断：') ||
    text.includes('本轮执行连接中断') ||
    text.includes('本地 Codex 内核暂时没有启动成功') ||
    text.includes('模型响应超时') ||
    text.includes('模型服务暂时不可用') ||
    codexRuntimeFailure ||
    /ECONNREFUSED|OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|timed out|timeout/i.test(text)
  )
}

function redactedEvidence(value: string) {
  return value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/Authorization:\s*[^\n]+/gi, 'Authorization: ***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

function failureEvidence(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const matched =
    lines.find((line) => /OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|50[024]|timeout|timed out|超时|Codex app-server|ECONNREFUSED|模型服务|技能代理|内核/i.test(line)) ??
    lines.at(-1) ??
    ''
  return redactedEvidence(matched)
}

export function runtimeFailureDiagnostic(items: CodexTranscriptItem[] | string) {
  const text = typeof items === 'string' ? items : items.map((item) => item.content).join('\n')
  const evidence = failureEvidence(text)
  const suffix = evidence ? ` 原始线索：${evidence}` : ''

  if (/OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|模型服务暂时不可用/i.test(text)) {
    return `失败诊断：模型通道鉴权失败。后台模型 KEY、Base URL 或默认模型可能不匹配，本轮已停止；请检查后台模型配置后重试。${suffix}`
  }
  if (/not activated the model|has not activated the model|activate the model service/i.test(text)) {
    return `失败诊断：视频模型尚未开通。火山方舟当前模型还没有激活，本轮已停止；请在 Ark 控制台开通后重试。${suffix}`
  }
  if (/timeout|timed out|超时|模型响应超时/i.test(text)) {
    const hasLargeScan = /node_modules|dist|release|\.git|package-lock|find .*type f|find .*maxdepth|grep -n|cat .*index\./i.test(text)
    if (hasLargeScan) {
      return `失败诊断：模型响应超时。本轮包含较大的项目扫描或命令输出，可能把上下文撑得过大；任务已停止，可以缩小扫描范围或新建对话重试。${suffix}`
    }
    return `失败诊断：模型响应超时。本轮已停止，可能是模型通道响应慢、上下文过大，或 app-server 没有正常返回。${suffix}`
  }
  if (/Codex app-server|Codex Runtime|ECONNREFUSED|本地 Codex 内核暂时没有启动成功/i.test(text)) {
    return `失败诊断：本地 Codex 执行连接中断。子进程或 app-server 没有正常收口，本轮已停止，可以重新发送。${suffix}`
  }
  return `失败诊断：本轮执行中断。任务状态已经收口为失败，可以重新发送；如果连续出现，需要看 Runtime 日志定位。${suffix}`
}

export function friendlyRuntimeMessage(content: string) {
  if (/本地 Codex 内核暂时没有启动成功/.test(content)) {
    return '本轮执行连接中断，已结束，可以重新发送。'
  }
  if (/not activated the model|has not activated the model|activate the model service/i.test(content)) {
    return '火山方舟视频模型还没有开通，请管理员到 Ark 控制台开通当前视频模型后再试。'
  }
  if (/OPENAI_API_KEY|invalid api key|403 Forbidden/i.test(content)) {
    return '模型服务暂时不可用，请检查模型密钥或稍后重试。'
  }
  if (/timeout|timed out|超时/i.test(content)) {
    return '模型响应超时，可以停止后重试，或检查模型服务状态。'
  }
  if (isRuntimeFailureNotice(content) && /Codex app-server|Codex Runtime|ECONNREFUSED/i.test(content)) {
    return '本轮执行连接中断，已结束，可以重新发送。'
  }
  return content.replace(/%!s\(int64=(\d+)\)/g, '$1')
}
