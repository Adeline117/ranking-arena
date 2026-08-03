const MAX_MENTION_HANDLE_LENGTH = 30
const HANDLE_CHARACTER_PATTERN =
  /^[A-Za-z0-9_.\u4E00-\u9FAF\u3041-\u309F\u30A0-\u30FF\uAC00-\uD7A3]$/u

export type MentionToken = Readonly<{
  start: number
  end: number
  handle: string
}>

export type MentionQuery = Readonly<{
  query: string
  start: number
}>

function isHandleCharacter(value: string | undefined): boolean {
  return value !== undefined && HANDLE_CHARACTER_PATTERN.test(value)
}

/** Find canonical handle tokens without treating the suffix of an email as a mention. */
export function findMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = []

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '@' || isHandleCharacter(text[start - 1])) continue

    let end = start + 1
    while (
      end < text.length &&
      end - start - 1 < MAX_MENTION_HANDLE_LENGTH &&
      isHandleCharacter(text[end])
    ) {
      end += 1
    }

    const handleLength = end - start - 1
    if (handleLength === 0 || isHandleCharacter(text[end])) continue
    tokens.push({ start, end, handle: text.slice(start + 1, end) })
    start = end - 1
  }

  return tokens
}

/** Resolve the active query immediately before a textarea cursor. */
export function getMentionQuery(
  text: string,
  cursorPosition: number,
  allowEmpty = false
): MentionQuery | null {
  if (!Number.isSafeInteger(cursorPosition) || cursorPosition < 0 || cursorPosition > text.length) {
    return null
  }

  const beforeCursor = text.slice(0, cursorPosition)
  const start = beforeCursor.lastIndexOf('@')
  if (start < 0 || isHandleCharacter(beforeCursor[start - 1])) return null

  const query = beforeCursor.slice(start + 1)
  if (
    query.length > MAX_MENTION_HANDLE_LENGTH ||
    (!allowEmpty && query.length === 0) ||
    [...query].some((character) => !isHandleCharacter(character))
  ) {
    return null
  }
  return { query, start }
}

export function extractMentionHandles(text: string, limit = 50): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return []

  const cappedLimit = Math.min(limit, 50)
  const handles = new Map<string, string>()
  for (const token of findMentionTokens(text.normalize('NFC'))) {
    const handle = token.handle.normalize('NFC')
    const key = handle.toLocaleLowerCase('und')
    if (!handles.has(key)) handles.set(key, handle)
    if (handles.size === cappedLimit) break
  }
  return [...handles.values()].sort((left, right) => left.localeCompare(right, 'und'))
}
