export type MarkdownImageToken = {
  raw: string
  alt: string
  url: string
  start: number
  end: number
}

export type MarkdownLinkToken = {
  raw: string
  label: string
  url: string
  start: number
  end: number
}

export type RawContentUrlToken = {
  url: string
  start: number
  end: number
}

export type MarkdownImageMoveResult = {
  content: string
  status: 'moved' | 'boundary' | 'missing'
}

/**
 * Parse the exact raw HTTP(S) URL grammar used by post content renderers.
 * Keep this separate from Markdown destinations: their explicit delimiters
 * intentionally allow a wider set of WHATWG-valid URL characters.
 */
export function findRawContentUrlTokens(content: string): RawContentUrlToken[] {
  const pattern = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const tokens: RawContentUrlToken[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    tokens.push({
      url: match[1],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return tokens
}

/** Parse non-image Markdown links without allowing destinations to span lines. */
export function findMarkdownLinkTokens(content: string): MarkdownLinkToken[] {
  const pattern = /\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g
  const tokens: MarkdownLinkToken[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    // Image destinations are handled by findMarkdownImageTokens, including
    // their leading `!`, so their ranges cannot be scanned twice as raw text.
    if (match.index > 0 && content[match.index - 1] === '!') continue

    tokens.push({
      raw: match[0],
      label: match[1],
      url: match[2],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return tokens
}

/** Parse the deliberately small Markdown image grammar supported by post composers. */
export function findMarkdownImageTokens(content: string): MarkdownImageToken[] {
  const pattern = /!\[([^\]\r\n]*)\]\(([^)\r\n]+)\)/g
  const tokens: MarkdownImageToken[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    tokens.push({
      raw: match[0],
      alt: match[1],
      url: match[2],
      start: match.index,
      end: match.index + match[0].length,
    })
  }

  return tokens
}

/** Swap an image with its adjacent image without temporary placeholder text. */
export function moveMarkdownImage(
  content: string,
  url: string,
  direction: 'up' | 'down'
): MarkdownImageMoveResult {
  const tokens = findMarkdownImageTokens(content)
  const currentIndex = tokens.findIndex((token) => token.url === url)
  if (currentIndex === -1) return { content, status: 'missing' }

  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (targetIndex < 0 || targetIndex >= tokens.length) {
    return { content, status: 'boundary' }
  }

  const current = tokens[currentIndex]
  const target = tokens[targetIndex]
  if (direction === 'up') {
    return {
      content:
        content.slice(0, target.start) +
        current.raw +
        content.slice(target.end, current.start) +
        target.raw +
        content.slice(current.end),
      status: 'moved',
    }
  }

  return {
    content:
      content.slice(0, current.start) +
      target.raw +
      content.slice(current.end, target.start) +
      current.raw +
      content.slice(target.end),
    status: 'moved',
  }
}

/** Remove the first image whose parsed URL exactly matches the requested object. */
export function removeMarkdownImage(
  content: string,
  url: string
): { content: string; removed: boolean } {
  const token = findMarkdownImageTokens(content).find((candidate) => candidate.url === url)
  if (!token) return { content, removed: false }

  return {
    content: `${content.slice(0, token.start)}${content.slice(token.end)}`
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    removed: true,
  }
}
