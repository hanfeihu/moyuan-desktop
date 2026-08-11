import type { CodexTask, CodexTaskEvent, RuntimeTaskItem, RuntimeTaskOutput, RuntimeTaskSource, RuntimeTurn } from './index.js'

export type CodexTranscriptItem = CodexTask['transcript'][number]
export type StructuredTaskEvent = Pick<CodexTaskEvent, 'approval' | 'item' | 'output' | 'plan' | 'pluginRequest' | 'raw' | 'source' | 'timestamp' | 'turnId' | 'type'>
export type RuntimeTaskStatusExplanation = {
  detail?: string
  kind: 'queued' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'interrupted'
  title: string
}

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
  const enterpriseFailure =
    /(Token\s*额度不足|当前没有可用\s*Token|额度不足|请先登录墨渊账号|登录状态已失效|账号已停用|企业后台暂时不可用)/i.test(text) ||
    /(plugin-assets|素材上传失败|文件上传失败|Payload Too Large|413)/i.test(text) ||
    /(图片生成失败|图片没有生成出来|图片模型通道|图片服务.*失败|图片生成接口)/i.test(text) ||
    /(视频生成失败|视频没有生成成功|视频服务.*失败|火山方舟.*(失败|未开通)|Ark.*(failed|error))/i.test(text) ||
    /(本地任务状态丢失|任务状态已丢失|Runtime 已重启|任务不存在|Runtime 返回 404)/i.test(text)

  return (
    text.startsWith('失败诊断：') ||
    text.includes('本轮执行连接中断') ||
    text.includes('本地 Codex 内核暂时没有启动成功') ||
    text.includes('模型响应超时') ||
    text.includes('模型服务暂时不可用') ||
    codexRuntimeFailure ||
    enterpriseFailure ||
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

  if (/Token\s*额度不足|当前没有可用\s*Token|额度不足|insufficient quota|quota exceeded|balance/i.test(text)) {
    return `失败诊断：Token 额度不足。本轮没有继续执行；请充值或让管理员派发额度后重试。${suffix}`
  }
  if (/请先登录墨渊账号|登录状态已失效|账号已停用|未授权的本地 Runtime 请求/i.test(text)) {
    return `失败诊断：账号状态不可用。本轮没有继续执行；请重新登录，或让管理员检查账号状态。${suffix}`
  }
  if (/plugin-assets|插件表单提交失败|素材上传失败|文件上传失败|Payload Too Large|413/i.test(text)) {
    return `失败诊断：插件素材上传失败。表单里的图片、视频或音频没有成功交给后台；可以压缩素材或重新提交插件表单。${suffix}`
  }
  if (/not activated the model|has not activated the model|activate the model service|视频模型.*(尚未|未|没有)开通|火山方舟.*模型.*(尚未|未|没有)开通/i.test(text)) {
    return `失败诊断：视频模型尚未开通。火山方舟当前模型还没有激活，本轮已停止；请在 Ark 控制台开通后重试。${suffix}`
  }
  if (/OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized|模型服务暂时不可用/i.test(text)) {
    return `失败诊断：模型通道鉴权失败。后台模型 KEY、Base URL 或默认模型可能不匹配，本轮已停止；请检查后台模型配置后重试。${suffix}`
  }
  if (/敏感信息|敏感内容|sensitive|safety|安全审核|content policy|policy violation/i.test(text)) {
    return `失败诊断：视频服务安全审核未通过。本轮没有生成资源；请把公众人物、敏感关系、暴力或容易误解的描述改成更中性的虚构表达后重试。${suffix}`
  }
  if (/图片模型通道.*(超时|504)|图片生成失败.*(504|技能代理|Gateway Timeout)|图片服务.*(Gateway Timeout|超时)|图片生成接口返回\s*504/i.test(text)) {
    return `失败诊断：图片模型通道超时。本轮没有生成图片资源；通常是图片服务排队、网关超时或通道波动，可以直接重试，或把画面描述收窄后再试。${suffix}`
  }
  if (/图片模型通道鉴权失败|图片.*(invalid api key|401|403|Unauthorized|Forbidden)|图片生成技能未启用/i.test(text)) {
    return `失败诊断：图片模型通道配置不可用。本轮没有生成图片资源；请检查后台图片技能的 KEY、Base URL 和默认模型。${suffix}`
  }
  if (/图片生成接口没有返回 usage\.total_tokens|图片.*无法计费|图片.*计费用量/i.test(text)) {
    return `失败诊断：图片生成计费信息缺失。本轮没有生成可入账图片；系统为了避免扣错 Token 没有继续入账，需要检查图片代理返回格式。${suffix}`
  }
  if (/图片生成失败|图片没有生成出来|图片模型通道|图片服务|图片生成接口/i.test(text)) {
    return `失败诊断：图片生成服务返回失败。本轮没有生成图片资源；可以调整提示词或稍后重试。${suffix}`
  }
  if (/视频生成失败|视频没有生成成功|视频服务|content_generation|火山方舟|Ark/i.test(text)) {
    return `失败诊断：视频生成服务返回失败。本轮没有生成视频资源；可以调整提示词或素材后重试。${suffix}`
  }
  if (/企业后台暂时不可用|Failed to fetch|NetworkError|fetch failed|ECONNRESET|Bad Gateway|Service Unavailable|Gateway Timeout|50[234]/i.test(text)) {
    return `失败诊断：企业后台暂时不可用。本轮没有继续执行；请稍后重试，或检查后台服务状态。${suffix}`
  }
  if (/本地任务状态丢失|任务状态已丢失|Runtime 已重启|任务不存在|Runtime 返回 404/i.test(text)) {
    return `失败诊断：本地任务状态丢失。Runtime 重启或任务记录丢失后无法继续追踪本轮；可以重新发送。${suffix}`
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
  const withoutEvidence = content.replace(/\s*原始线索：.*$/s, '').trim()
  if (withoutEvidence.startsWith('失败诊断：') && /Token\s*额度不足|当前没有可用\s*Token|额度不足/i.test(withoutEvidence)) {
    return 'Token 额度不足，任务已停止。充值或让管理员派发额度后可以重试。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /账号状态不可用|请先登录墨渊账号|登录状态已失效|账号已停用/i.test(withoutEvidence)) {
    return '账号状态不可用，任务已停止。请重新登录，或让管理员检查账号状态。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /插件素材上传失败|plugin-assets|素材上传|文件上传|Payload Too Large|413/i.test(withoutEvidence)) {
    return '插件素材上传失败，任务已停止。可以压缩素材后重新提交表单。'
  }
  if (content.startsWith('失败诊断：') && /本地 Codex|Codex app-server|Codex Runtime|ECONNREFUSED|连接中断|没有正常收口/i.test(content)) {
    return '本地 Codex 连接中断，已停止。可以重新发送；详细原因已写入本地日志。'
  }
  if (content.startsWith('失败诊断：') && /模型通道鉴权失败|OPENAI_API_KEY|invalid api key|403 Forbidden|401 Unauthorized/i.test(content)) {
    return '模型服务暂时不可用，已停止。请检查后台模型配置后重试。'
  }
  if (content.startsWith('失败诊断：') && /超时|timeout|timed out/i.test(content)) {
    return '模型响应超时，已停止。可以缩小任务范围或稍后重试。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /图片模型通道超时|图片.*504|Gateway Timeout/i.test(withoutEvidence)) {
    return '图片模型通道超时，这次没有生成图片。通常是上游排队或网关波动，可以重新发送。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /图片模型通道配置不可用|图片模型通道鉴权失败|图片生成技能未启用/i.test(withoutEvidence)) {
    return '图片生成通道配置不可用，请管理员检查后台图片技能的 KEY、Base URL 和默认模型。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /图片生成计费信息缺失|无法计费|计费用量/i.test(withoutEvidence)) {
    return '图片生成返回缺少计费用量，系统没有扣错 Token。需要检查图片代理返回格式。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /图片生成服务返回失败|图片生成失败|图片没有生成出来|图片模型通道|图片服务/i.test(withoutEvidence)) {
    return '图片生成服务返回失败，这次没有生成图片。可以调整提示词或稍后重试。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /视频服务安全审核未通过|安全审核|content policy|policy violation/i.test(withoutEvidence)) {
    return '视频服务安全审核未通过，任务已停止。可以把人物、关系或动作描述改得更中性后重试。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /视频模型尚未开通|火山方舟.*模型.*(尚未|未|没有)开通/i.test(withoutEvidence)) {
    return '火山方舟视频模型还没有开通，请管理员到 Ark 控制台开通当前视频模型后再试。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /视频生成服务返回失败|视频生成失败|视频没有生成成功|视频服务/i.test(withoutEvidence)) {
    return '视频生成服务返回失败，任务已停止。可以调整提示词或素材后重试。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /企业后台暂时不可用|后台服务状态/i.test(withoutEvidence)) {
    return '企业后台暂时不可用，任务已停止。请稍后重试，或检查后台服务状态。'
  }
  if (withoutEvidence.startsWith('失败诊断：') && /本地任务状态丢失|Runtime 重启|任务记录丢失/i.test(withoutEvidence)) {
    return '本地 Runtime 已重启，这个任务状态已丢失。可以重新发送。'
  }
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
  if (withoutEvidence.startsWith('失败诊断：')) {
    return withoutEvidence.replace(/^失败诊断：/, '').replace(/%!s\(int64=(\d+)\)/g, '$1')
  }
  return withoutEvidence.replace(/%!s\(int64=(\d+)\)/g, '$1')
}

function latestFailureContent(task: CodexTask) {
  const items = [...(task.items ?? [])].reverse()
  const failedItem = items.find((item) => item.status === 'failed' && (item.content || item.summary || item.title))
  if (failedItem) return failedItem.content || failedItem.summary || failedItem.title

  const failedTurn = [...(task.turns ?? [])].reverse().find((turn) => turn.status === 'failed' && turn.error)
  if (failedTurn?.error) return failedTurn.error

  const transcriptFailure = [...(task.transcript ?? [])].reverse().find((item) => {
    const text = item.content.trim()
    return text.startsWith('失败诊断：') || isRuntimeFailureNotice(text) || /^Codex\s*任务退出，代码/.test(text)
  })
  return transcriptFailure?.content
}

function metadataText(metadata: Record<string, unknown> | undefined, key: string) {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function latestItemWithStatus(task: CodexTask, status: RuntimeTaskItem['status']) {
  return [...(task.items ?? [])].reverse().find((item) => item.status === status)
}

function latestVisibleItemWithStatus(task: CodexTask, status: RuntimeTaskItem['status']) {
  return [...(task.items ?? [])].reverse().find((item) => item.status === status && isVisibleProgressItem(item))
}

function isVisibleProgressItem(item: RuntimeTaskItem) {
  const rawType = normalizeStructuredType(item.metadata?.type)
  if (item.type === 'system' || item.type === 'user_message' || item.type === 'assistant_message' || item.type === 'reasoning') return false
  if (rawType === 'usermessage' || rawType === 'agentmessage' || rawType === 'agentmessageevent') return false
  if (/^(userMessage|agentMessage)$/i.test(item.title.trim())) return false
  return true
}

function itemProgressDetail(item: RuntimeTaskItem) {
  if (item.type !== 'video_generation') return item.content
  if (item.metadata?.handledFailure === true) return item.content || '视频服务没有生成资源，墨渊已说明原因。'
  const rawStatus = metadataText(item.metadata, 'rawStatus')
  const providerTaskId = metadataText(item.metadata, 'providerTaskId')
  if (rawStatus && providerTaskId) return `平台状态：${rawStatus}，Runtime 会继续查询结果。`
  if (rawStatus) return `平台状态：${rawStatus}，Runtime 会继续查询结果。`
  if (providerTaskId) return '视频任务已创建，Runtime 正在查询生成结果。'
  return item.content || '正在准备视频生成服务。'
}

export function runtimeTaskStatusExplanation(task: CodexTask, elapsedMs = 0): RuntimeTaskStatusExplanation | undefined {
  const pendingPlugin = (task.pluginRequests ?? []).find((request) => request.status === 'pending')
  if (pendingPlugin && task.status !== 'interrupted') {
    return {
      kind: 'waiting_input',
      title: '等待插件表单',
      detail: `${pendingPlugin.title} 需要补充后继续执行。`,
    }
  }

  if (task.status === 'failed') {
    const failedVideoItem = [...(task.items ?? [])].reverse().find((item) => item.type === 'video_generation' && item.status === 'failed')
    const content = failedVideoItem?.content || latestFailureContent(task) || '任务没有正常完成'
    return {
      kind: 'failed',
      title: failedVideoItem ? '视频没有生成' : '需要处理',
      detail: friendlyRuntimeMessage(runtimeFailureDiagnostic(content)),
    }
  }

  if (task.status === 'interrupted') {
    return {
      kind: 'interrupted',
      title: '任务已停止',
      detail: '这轮执行已经中断，可以在当前对话里重新发送。',
    }
  }

  if (task.status === 'completed') {
    const outputCount = task.outputs?.length ?? 0
    const handledVideoItem = [...(task.items ?? [])].reverse().find((item) => item.type === 'video_generation' && item.metadata?.handledFailure === true)
    if (handledVideoItem) {
      return {
        kind: 'completed',
        title: '视频请求已处理',
        detail: '这次没有生成视频资源，墨渊已经在聊天里说明原因和修改建议。',
      }
    }
    return outputCount
      ? { kind: 'completed', title: '任务已完成', detail: `已整理 ${outputCount} 个输出。` }
      : undefined
  }

  if (task.status === 'queued') {
    return {
      kind: 'queued',
      title: '已发送，正在创建任务',
      detail: elapsedMs > 7000 ? '如果这里停留很久，通常是账号校验、Runtime 启动或后台连接较慢。' : undefined,
    }
  }

  if (task.status === 'running' || task.status === 'needs_approval') {
    const runningVideoItem = [...(task.items ?? [])].reverse().find((item) => item.type === 'video_generation' && item.status === 'in_progress')
    if (runningVideoItem) {
      return {
        kind: 'running',
        title: '视频正在生成',
        detail: itemProgressDetail(runningVideoItem),
      }
    }

    const runningItem = latestVisibleItemWithStatus(task, 'in_progress')
    if (runningItem) {
      return {
        kind: 'running',
        title: runningItem.title,
        detail: runningItem.content || runningItem.summary,
      }
    }

    return {
      kind: 'running',
      title: elapsedMs > 9000 ? 'Codex 仍在编排' : 'Codex 正在编排',
      detail: elapsedMs > 9000 ? '可能正在准备工具调用、等待模型返回，或等待 Runtime 推送事件。' : undefined,
    }
  }

  return undefined
}

export function applyTaskStructureEvent(task: CodexTask, event: StructuredTaskEvent) {
  ensureStructuredTask(task)
  const timestamp = event.timestamp
  const raw = event.raw && typeof event.raw === 'object' ? (event.raw as Record<string, unknown>) : undefined
  const rawParams = raw?.params && typeof raw.params === 'object' ? (raw.params as Record<string, unknown>) : raw
  const rawItem = rawParams?.item && typeof rawParams.item === 'object' ? (rawParams.item as Record<string, unknown>) : undefined
  const turnId = event.turnId ?? firstStructuredString(rawParams?.turnId, rawParams?.turn_id, rawParams?.turn && typeof rawParams.turn === 'object' ? (rawParams.turn as { id?: unknown }).id : undefined)

  if (event.type === 'turn.started' || event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'turn.interrupted') {
    const explicitTurnId = turnId || firstStructuredString(rawParams?.id)
    if (explicitTurnId) {
      upsertTurn(task, {
        id: explicitTurnId,
        status: event.type === 'turn.started' ? 'in_progress' : event.type === 'turn.failed' ? 'failed' : event.type === 'turn.interrupted' ? 'interrupted' : 'completed',
        startedAt: event.type === 'turn.started' ? timestamp : undefined,
        completedAt: event.type === 'turn.started' ? undefined : timestamp,
        error: event.type === 'turn.failed' ? eventText(event) : undefined,
      })
    }
  }

  if (event.plan?.length) {
    task.plan = event.plan
    if (turnId) {
      const turn = upsertTurn(task, { id: turnId, status: 'in_progress' })
      turn.plan = event.plan
    }
  }

  const item = event.item ?? structuredItemFromRaw(rawItem, event)
  if (item) {
    upsertItem(task, {
      ...item,
      turnId: item.turnId ?? turnId,
      startedAt: item.startedAt ?? (event.type === 'item.started' ? timestamp : undefined),
      completedAt: item.completedAt ?? (event.type === 'item.completed' ? timestamp : undefined),
    })
  }

  if (event.approval) {
    task.approvals = upsertById(task.approvals ?? [], event.approval)
  }

  if (event.pluginRequest) {
    task.pluginRequests = upsertById(task.pluginRequests ?? [], event.pluginRequest)
  }

  const source = event.source ?? sourceFromStructuredItem(item, timestamp)
  if (source) {
    task.sources = upsertById(task.sources ?? [], source)
  }

  const output = event.output ?? outputFromStructuredItem(item, timestamp)
  if (output) {
    task.outputs = upsertById(task.outputs ?? [], { ...output, turnId: output.turnId ?? turnId })
  }
}

function ensureStructuredTask(task: CodexTask) {
  task.items ??= []
  task.outputs ??= []
  task.approvals ??= []
  task.pluginRequests ??= []
  task.sources ??= []
  task.turns ??= []
}

function upsertTurn(task: CodexTask, next: RuntimeTurn) {
  task.turns ??= []
  const index = task.turns.findIndex((turn) => turn.id === next.id)
  if (index >= 0) {
    task.turns[index] = {
      ...task.turns[index],
      ...next,
      startedAt: task.turns[index].startedAt ?? next.startedAt,
      completedAt: next.completedAt ?? task.turns[index].completedAt,
    }
    return task.turns[index]
  }
  task.turns.push(next)
  return next
}

function upsertItem(task: CodexTask, next: RuntimeTaskItem) {
  task.items ??= []
  const index = task.items.findIndex((item) => item.id === next.id)
  if (index >= 0) {
    task.items[index] = {
      ...task.items[index],
      ...next,
      metadata: { ...(task.items[index].metadata ?? {}), ...(next.metadata ?? {}) },
      startedAt: task.items[index].startedAt ?? next.startedAt,
      completedAt: next.completedAt ?? task.items[index].completedAt,
    }
    return task.items[index]
  }
  task.items.push(next)
  return next
}

function upsertById<T extends { id: string }>(items: T[], next: T) {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [next, ...items]
  return items.map((item) => (item.id === next.id ? { ...item, ...next } : item))
}

function structuredItemFromRaw(rawItem: Record<string, unknown> | undefined, event: StructuredTaskEvent): RuntimeTaskItem | undefined {
  if (!rawItem) return event.item
  const rawType = normalizeStructuredType(rawItem.type)
  const id = firstStructuredString(rawItem.id, rawItem.itemId, rawItem.item_id, event.item?.id)
  if (!id) return undefined
  const status = structuredStatus(firstStructuredString(rawItem.status), event.type)
  const metadata = { rawType: rawItem.type, ...rawItem }

  if (rawType === 'commandexecution') {
    const command = firstStructuredString(rawItem.command, rawItem.commandLine, rawItem.command_line)
    return {
      id,
      type: 'command',
      title: command ? `运行命令：${command}` : '运行命令',
      status,
      content: firstStructuredString(rawItem.aggregatedOutput, rawItem.aggregated_output, rawItem.output),
      metadata,
    }
  }

  if (rawType === 'filechange') {
    const changes = Array.isArray(rawItem.changes) ? rawItem.changes : []
    const paths = changes.map((change) => (change && typeof change === 'object' ? firstStructuredString((change as { path?: unknown }).path) : '')).filter(Boolean)
    return {
      id,
      type: 'file_change',
      title: paths.length ? `修改文件：${paths.slice(0, 3).join(', ')}` : '修改文件',
      status,
      summary: paths.join('\n'),
      metadata,
    }
  }

  if (rawType === 'mcptoolcall' || rawType === 'dynamictoolcall') {
    const tool = firstStructuredString(rawItem.tool, rawItem.toolName, rawItem.tool_name)
    const server = firstStructuredString(rawItem.server, rawItem.namespace)
    return {
      id,
      type: rawType === 'dynamictoolcall' ? 'plugin' : 'tool_call',
      title: [server, tool].filter(Boolean).join(' / ') || '调用工具',
      status,
      metadata,
    }
  }

  if (rawType === 'websearch') {
    const query = firstStructuredString(rawItem.query)
    return { id, type: 'web_search', title: query ? `网页搜索：${query}` : '网页搜索', status, metadata }
  }

  if (rawType === 'usermessage') {
    return {
      id,
      type: 'user_message',
      title: '收到你的消息',
      status: 'completed',
      content: firstStructuredString(rawItem.text, rawItem.message, textFromStructuredContent(rawItem.content)),
      metadata,
    }
  }

  if (rawType === 'imagegeneration') {
    return {
      id,
      type: 'image_generation',
      title: '生成图片',
      status,
      content: firstStructuredString(rawItem.result, rawItem.savedPath, rawItem.saved_path),
      metadata,
    }
  }

  if (rawType === 'agentmessage') {
    return {
      id,
      type: 'assistant_message',
      title: '生成回复',
      status,
      content: firstStructuredString(rawItem.text, rawItem.message),
      metadata,
    }
  }

  if (rawType === 'reasoning') return { id, type: 'reasoning', title: '思考', status, metadata }
  return { id, type: 'system', title: firstStructuredString(rawItem.type) || '任务事件', status, metadata }
}

function textFromStructuredContent(value: unknown) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      return firstStructuredString(record.text, record.content, record.value)
    })
    .filter(Boolean)
    .join('')
}

function outputFromStructuredItem(item: RuntimeTaskItem | undefined, timestamp: string): RuntimeTaskOutput | undefined {
  if (!item || item.status !== 'completed') return undefined
  const metadata = item.metadata ?? {}
  if (item.type === 'image_generation') {
    const url = firstStructuredString(metadata.savedPath, metadata.saved_path, metadata.result, item.content)
    if (!url) return undefined
    return { id: `output-${item.id}`, type: 'image', title: '生成图片', path: url.startsWith('/') ? url : undefined, url: url.startsWith('http') ? url : undefined, taskItemId: item.id, createdAt: timestamp }
  }
  if (item.type === 'file_change') {
    return { id: `output-${item.id}`, type: 'file', title: item.title, taskItemId: item.id, metadata, createdAt: timestamp }
  }
  return undefined
}

function sourceFromStructuredItem(item: RuntimeTaskItem | undefined, timestamp: string): RuntimeTaskSource | undefined {
  if (!item) return undefined
  const metadata = item.metadata ?? {}
  if (item.type === 'web_search') {
    const query = firstStructuredString(metadata.query, item.summary, item.content)
    const action = metadata.action && typeof metadata.action === 'object' ? (metadata.action as Record<string, unknown>) : undefined
    const url = firstStructuredString(action?.url, metadata.url)
    return {
      id: `source-${item.id}`,
      type: 'web',
      title: query ? `网页搜索：${query}` : '网页搜索',
      query,
      url,
      taskItemId: item.id,
      metadata,
      createdAt: timestamp,
    }
  }
  if (item.type === 'tool_call' || item.type === 'command') {
    return {
      id: `source-${item.id}`,
      type: item.type === 'command' ? 'tool' : 'plugin',
      title: item.title,
      taskItemId: item.id,
      metadata,
      createdAt: timestamp,
    }
  }
  if (item.type === 'plugin' || item.type === 'image_generation' || item.type === 'video_generation') {
    return {
      id: `source-${item.id}`,
      type: item.type === 'plugin' ? 'plugin' : 'skill',
      title: item.title,
      taskItemId: item.id,
      metadata,
      createdAt: timestamp,
    }
  }
  return undefined
}

function structuredStatus(value: string, eventType: StructuredTaskEvent['type']): RuntimeTaskItem['status'] {
  const normalized = normalizeStructuredType(value)
  if (eventType === 'item.started') return 'in_progress'
  if (normalized === 'inprogress' || normalized === 'running') return 'in_progress'
  if (normalized === 'failed' || normalized === 'error') return 'failed'
  if (normalized === 'declined') return 'declined'
  if (eventType === 'item.completed') return 'completed'
  if (normalized === 'completed' || normalized === 'succeeded') return 'completed'
  return 'pending'
}

function firstStructuredString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}

function normalizeStructuredType(value: unknown) {
  return typeof value === 'string' ? value.replace(/[_\s-]/g, '').toLowerCase() : ''
}

function eventText(event: StructuredTaskEvent) {
  return typeof (event as { content?: unknown }).content === 'string' ? String((event as { content?: unknown }).content) : ''
}
