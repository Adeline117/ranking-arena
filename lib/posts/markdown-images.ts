export type MarkdownImageToken = {
  raw: string
  alt: string
  url: string
  start: number
  end: number
}

export type MarkdownImageMoveResult = {
  content: string
  status: 'moved' | 'boundary' | 'missing'
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
