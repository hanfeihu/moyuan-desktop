export function isCommandToolContent(content: string) {
  return content.trimStart().startsWith('$')
}

export function ToolOutput({ content }: { content: string }) {
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
