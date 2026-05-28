import React, { useEffect, useId, useMemo, useState } from 'react'
import { runtimeEndpoint } from '../../api'
import { errorLogDetails, logClientEvent } from '../../logger'

type MarkdownBlock =
  | { type: 'paragraph' | 'heading' | 'quote'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'divider' }
  | { type: 'image'; alt: string; src: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'video'; alt: string; src: string }
  | { type: 'list'; ordered: boolean; start?: number; items: Array<{ body: string; meta?: string }> }

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null

function loadMermaid() {
  mermaidLoader ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      fontFamily: 'var(--font-sans)',
      securityLevel: 'strict',
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        background: '#fbfbfa',
        clusterBkg: '#f7f7f4',
        clusterBorder: '#e7e3da',
        edgeLabelBackground: '#fbfbfa',
        fontFamily: 'var(--font-sans)',
        lineColor: '#c9c4ba',
        mainBkg: '#ffffff',
        nodeBorder: '#ded9cf',
        primaryBorderColor: '#ded9cf',
        primaryColor: '#ffffff',
        primaryTextColor: '#2f343b',
        secondaryBorderColor: '#e8e4dc',
        secondaryColor: '#f6f6f3',
        tertiaryColor: '#fbfbfa',
      },
    })
    return mermaid
  })
  return mermaidLoader
}


export function MarkdownText({ content }: { content: string }) {
  const blocks = useMemo(() => markdownBlocks(content), [content])

  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul'
          const listProps = block.ordered && block.start ? { start: block.start } : {}
          return (
            <ListTag {...listProps} key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <div>{renderInline(item.body)}</div>
                  {item.meta ? <div className="list-meta">{renderInline(item.meta)}</div> : null}
                </li>
              ))}
            </ListTag>
          )
        }

        if (block.type === 'heading') {
          return <h3 key={index}>{renderInline(block.text)}</h3>
        }

        if (block.type === 'code') {
          if (block.language?.toLowerCase() === 'mermaid') {
            return <MermaidDiagram code={block.code} key={index} />
          }
          return (
            <pre className="code-block" key={index}>
              {block.language ? <span className="code-language">{block.language}</span> : null}
              <code>{block.code}</code>
            </pre>
          )
        }

        if (block.type === 'divider') {
          return <hr className="markdown-divider" key={index} />
        }

        if (block.type === 'table') {
          return (
            <div className="markdown-table-wrap" key={index}>
              <table className="markdown-table">
                <thead>
                  <tr>
                    {block.headers.map((header, cellIndex) => (
                      <th key={cellIndex}>{renderInline(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={cellIndex}>{renderInline(row[cellIndex] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }

        if (block.type === 'quote') {
          return <blockquote key={index}>{renderInline(block.text)}</blockquote>
        }

        if (block.type === 'image') {
          const src = resolveRuntimeAssetUrl(block.src)
          return (
            <figure className="image-result" key={index}>
              <button aria-label="打开图片" className="image-result-button" onClick={() => window.open(src, '_blank', 'noopener,noreferrer')} type="button">
                <img alt={block.alt} onLoad={() => window.dispatchEvent(new Event('moyuan:content-resized'))} src={src} />
              </button>
            </figure>
          )
        }

        if (block.type === 'video') {
          return (
            <figure className="video-result" key={index}>
              <video controls onLoadedMetadata={() => window.dispatchEvent(new Event('moyuan:content-resized'))} src={resolveRuntimeAssetUrl(block.src)} />
              {block.alt ? <figcaption>{block.alt}</figcaption> : null}
            </figure>
          )
        }

        return <p key={index}>{renderInline(block.text)}</p>
      })}
    </div>
  )
}

function MermaidDiagram({ code }: { code: string }) {
  const reactId = useId()
  const diagramId = useMemo(() => `moyuan-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`, [reactId])
  const renderCode = useMemo(() => sanitizeMermaid(code), [code])
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    loadMermaid()
      .then((mermaid) => mermaid.render(diagramId, renderCode))
      .then((result) => {
        if (cancelled) return
        setSvg(result.svg)
        setError('')
        window.requestAnimationFrame(() => window.dispatchEvent(new Event('moyuan:content-resized')))
      })
      .catch((renderError: unknown) => {
        if (cancelled) return
        setSvg('')
        setError('图表语法暂时无法自动修复，已切换为源码视图。')
        logClientEvent(
          'mermaid.render.failed',
          errorLogDetails(renderError, {
            codeLength: code.length,
            sanitized: renderCode !== code,
          }),
          'warn',
        )
      })

    return () => {
      cancelled = true
    }
  }, [code, diagramId, renderCode])

  if (error) {
    return (
      <details className="mermaid-fallback">
        <summary>{error}</summary>
        <pre className="code-block">
          <code>{renderCode}</code>
        </pre>
      </details>
    )
  }

  if (!svg) return <div className="mermaid-loading">正在整理图表...</div>

  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />
}

function sanitizeMermaid(code: string) {
  const firstLine = code.trimStart().split(/\r?\n/, 1)[0]?.trim().toLowerCase() ?? ''
  if (!/^flowchart\b|^graph\b/.test(firstLine)) return code

  return code
    .split(/\r?\n/)
    .map((line) => sanitizeFlowchartLine(line))
    .join('\n')
}

function sanitizeFlowchartLine(line: string) {
  const withoutComments = line.split('%%', 1)[0] ?? line
  if (!withoutComments.includes('[')) return line

  return quoteUnsafeNodeLabels(line)
}

function quoteUnsafeNodeLabels(line: string) {
  let result = ''
  let cursor = 0

  while (cursor < line.length) {
    const start = line.indexOf('[', cursor)
    if (start < 0) {
      result += line.slice(cursor)
      break
    }

    const end = findNodeLabelEnd(line, start)
    if (end < 0) {
      result += line.slice(cursor)
      break
    }

    const label = line.slice(start + 1, end)
    result += line.slice(cursor, start)
    result += shouldQuoteMermaidLabel(label) ? `["${escapeMermaidLabel(label)}"]` : `[${label}]`
    cursor = end + 1
  }

  return result
}

function findNodeLabelEnd(line: string, start: number) {
  let quoted = false
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && line[index - 1] !== '\\') quoted = !quoted
    if (char === ']' && !quoted) return index
  }
  return -1
}

function shouldQuoteMermaidLabel(label: string) {
  const trimmed = label.trim()
  if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'")) return false
  return /[<@/()（）{}，、；：:]|\s[-+]\s/.test(trimmed)
}

function escapeMermaidLabel(label: string) {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function resolveRuntimeAssetUrl(src: string) {
  if (src.startsWith('/api/')) return runtimeEndpoint(src)
  return src
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex]
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
      flushList()
      continue
    }

    if (/^-{3,}$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'divider' })
      continue
    }

    const nextLine = lines[lineIndex + 1]?.trim() ?? ''
    if (isMarkdownTableHeader(line, nextLine)) {
      flushParagraph()
      flushList()
      const headers = splitTableRow(line)
      const rows: string[][] = []
      let cursor = lineIndex + 2

      while (cursor < lines.length) {
        const rowLine = lines[cursor].trim()
        if (!isMarkdownTableRow(rowLine)) break
        rows.push(splitTableRow(rowLine))
        cursor += 1
      }

      blocks.push({ type: 'table', headers, rows })
      lineIndex = cursor - 1
      continue
    }

    const unorderedListMatch = line.match(/^[-*]\s+(.+)$/)
    const orderedListMatch = line.match(/^(\d+)[.)]\s+(.+)$/)
    const imageMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (imageMatch) {
      flushParagraph()
      flushList()
      const src = imageMatch[2]
      if (/\.(mp4|webm|mov)(\?|#|$)/i.test(src)) {
        blocks.push({ type: 'video', alt: imageMatch[1], src })
      } else {
        blocks.push({ type: 'image', alt: imageMatch[1], src })
      }
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

    const atxHeadingMatch = line.match(/^#{1,6}\s+(.+)$/)
    const headingMatch = line.match(/^\*\*(.+)\*\*[:：]?$/)
    if (atxHeadingMatch) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', text: atxHeadingMatch[1] })
      continue
    }

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

function isMarkdownTableHeader(line: string, nextLine: string) {
  return isMarkdownTableRow(line) && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(nextLine)
}

function isMarkdownTableRow(line: string) {
  return line.includes('|') && line.split('|').length >= 3
}

function splitTableRow(line: string) {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
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
