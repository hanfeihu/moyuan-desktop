const maxContextBlockLength = 9000
const maxCommandHistoryItemLength = 1800
const maxDiffContextLength = 2400

const codexOperatingGuidance = [
  '项目分析和排障时优先使用 rg、rg --files、精确目录和小范围读取。',
  '默认避开 node_modules、dist、release、build、coverage、.git、package-lock.json 等大型依赖或构建产物，除非用户明确要求。',
  '命令输出很长时先总结关键路径和结论，再按需继续读取，不要把大段无关输出放进上下文。',
].join('\n')

export function buildBaseInstructions(skillInstructions: string) {
  return [codexOperatingGuidance, skillInstructions].filter(Boolean).join('\n\n')
}

export function buildPromptWithContext(prompt: string, context: {
  commandHistory?: string[]
  diffSummary?: string
  memory?: string
  skillInstructions: string
}) {
  const commandContext = boundedJoin(context.commandHistory?.slice(-8) ?? [], maxContextBlockLength)
  const contextBlock = [
    context.skillInstructions,
    codexOperatingGuidance,
    context.memory ? `工作区记忆:\n${truncateMiddle(context.memory, maxContextBlockLength)}` : '',
    commandContext ? `最近命令历史:\n${commandContext}` : '',
    context.diffSummary ? `当前文件变更摘要:\n${truncateMiddle(context.diffSummary, maxDiffContextLength)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  return contextBlock ? `${contextBlock}\n\n用户本轮请求:\n${prompt}` : prompt
}

function boundedJoin(items: string[], maxLength: number) {
  const result: string[] = []
  let length = 0
  for (const item of items) {
    const next = truncateMiddle(item, maxCommandHistoryItemLength)
    if (length + next.length > maxLength) break
    result.push(next)
    length += next.length
  }
  return result.join('\n\n')
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  const headLength = Math.floor(maxLength * 0.65)
  const tailLength = Math.max(0, maxLength - headLength - 80)
  return `${value.slice(0, headLength)}\n\n... 输出过长，已截断 ${value.length - headLength - tailLength} 个字符 ...\n\n${value.slice(-tailLength)}`
}
