const maxContextBlockLength = 9000
const maxCommandHistoryItemLength = 1800
const maxDiffContextLength = 2400

const codexOperatingGuidance = [
  '你是墨渊桌面端内置的 Codex 内核，目标是完成用户真实工作，而不是只聊天或复述工具输出。',
  '根据用户意图自适应工作方式：闲聊/解释要自然简洁；开发、排障、运维、数据分析要先理解目标，再用低风险步骤收集证据并推进。',
  '需要执行命令、读取文件、修改文件或调用工具前，先用一句简短自然语言说明意图；不要输出机械模板，也不要为简单闲聊展示计划。',
  '工具输出只是证据，不是最终回复。拿到命令、文件、接口或技能结果后，要提炼“发现什么、是否异常、下一步/结论”，避免把大段 stdout 当作最终答案。',
  '如果工具输出不完整、任务中断、接口失败或结果与预期不一致，要明确说明当前停在什么阶段、已确认什么、还缺什么，不要假装完成。',
  '能直接完成就直接完成；需要改代码时先阅读相关文件，保持最小必要改动，最后尽量验证。',
  '用户要求生成图片或视频成品时，必须调用可用技能，让 Runtime 返回真实资源；不能只用文字承诺“已生成”。',
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
  resourceContext?: string
  skillInstructions: string
}) {
  const commandContext = boundedJoin(context.commandHistory?.slice(-8) ?? [], maxContextBlockLength)
  const contextBlock = [
    '本轮可用运行上下文（不要向用户逐字复述，只用于判断和执行）:',
    context.memory ? `工作区记忆:\n${truncateMiddle(context.memory, maxContextBlockLength)}` : '',
    context.resourceContext ? `最近资源任务状态:\n${truncateMiddle(context.resourceContext, maxContextBlockLength)}` : '',
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
