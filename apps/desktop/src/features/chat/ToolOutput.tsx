export function isCommandToolContent(content: string) {
  return content.trimStart().startsWith('$')
}

function cleanShellCommand(command: string) {
  return command.replace(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+/, '').replace(/^["']|["']$/g, '').trim()
}

function commandActionSummary(command: string) {
  const cleaned = cleanShellCommand(command)
  const writeMatch = cleaned.match(/\b(?:cat|tee)\s+>?\s*["']?([^"'\s<>|]+)["']?\s*<<|>\s*["']?([^"'\s<>|]+)["']?/)
  const mkdirMatch = cleaned.match(/\bmkdir\s+(?:-[a-zA-Z]+\s+)*["']?([^"'\s;&|]+)["']?/)
  const touchMatch = cleaned.match(/\btouch\s+["']?([^"'\s;&|]+)["']?/)
  const openMatch = cleaned.match(/\b(?:sed|cat|head|tail|nl)\b.*?\s+["']?([^"'\s;&|]+)["']?$/)

  if (writeMatch) return `写入文件：${writeMatch[1] ?? writeMatch[2]}`
  if (mkdirMatch) return `创建目录：${mkdirMatch[1]}`
  if (touchMatch) return `创建文件：${touchMatch[1]}`
  if (/^\s*(?:rg|grep)\b/.test(cleaned)) return '搜索项目内容'
  if (/^\s*(?:ls|find)\b/.test(cleaned)) return '查看文件列表'
  if (/^\s*(?:npm|pnpm|yarn)\b/.test(cleaned)) return '运行项目脚本'
  if (/^\s*git\b/.test(cleaned)) return '检查代码状态'
  if (/^\s*curl\b/.test(cleaned)) return '请求接口'
  if (openMatch) return `查看文件：${openMatch[1]}`
  return '执行本地命令'
}

export function ToolOutput({ content }: { content: string }) {
  const [firstLine, ...rest] = content.split(/\r?\n/)
  const isCommand = isCommandToolContent(firstLine ?? '')
  const command = isCommand ? firstLine?.replace(/^\$\s*/, '').trim() : ''
  const detail = rest.join('\n').trim()
  const summary = command ? commandActionSummary(command) : firstLine?.trim() || '工具调用'

  if (isCommand) {
    return (
      <details className="tool-output command-output">
        <summary>
          <span className="tool-summary-dot" />
          <span>{summary}</span>
          <code>查看命令</code>
        </summary>
        <pre spellCheck={false}>{detail ? `$ ${command}\n\n${detail}` : `$ ${command}`}</pre>
      </details>
    )
  }

  if (!detail) {
    return <div className="tool-status-row">{summary}</div>
  }

  return (
    <details className="tool-output">
      <summary>
        <span className="tool-summary-dot" />
        <span>{summary}</span>
        {command ? <code>{command}</code> : null}
      </summary>
      <pre spellCheck={false}>{detail}</pre>
    </details>
  )
}
