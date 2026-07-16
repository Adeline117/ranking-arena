const JSON_WHITESPACE_RE = /[\t\n\r ]/
const JSON_NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/
const MAX_JSON_DEPTH = 128

/**
 * Parse JSON while rejecting duplicate object keys, including keys that only
 * become equal after JSON escape decoding. Native JSON.parse silently keeps
 * the last duplicate and is therefore insufficient for evidence envelopes.
 */
export function parseStrictJson(text: string): unknown {
  let offset = 0

  const invalid = (): never => {
    throw new SyntaxError('invalid strict JSON')
  }
  const skipWhitespace = () => {
    while (offset < text.length && JSON_WHITESPACE_RE.test(text[offset])) offset += 1
  }
  const parseString = (): string => {
    if (text[offset] !== '"') return invalid()
    const start = offset
    offset += 1
    while (offset < text.length) {
      const code = text.charCodeAt(offset)
      if (code === 0x22) {
        offset += 1
        try {
          return JSON.parse(text.slice(start, offset)) as string
        } catch {
          return invalid()
        }
      }
      if (code < 0x20) return invalid()
      if (code === 0x5c) {
        offset += 1
        if (offset >= text.length) return invalid()
        if (text[offset] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(offset + 1, offset + 5))) return invalid()
          offset += 5
          continue
        }
        if (!/["\\/bfnrt]/.test(text[offset])) return invalid()
      }
      offset += 1
    }
    return invalid()
  }
  const parseLiteral = (literal: 'true' | 'false' | 'null') => {
    if (text.slice(offset, offset + literal.length) !== literal) return invalid()
    offset += literal.length
  }
  const parseValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) return invalid()
    skipWhitespace()
    const token = text[offset]
    if (token === '{') {
      offset += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (text[offset] === '}') {
        offset += 1
        return
      }
      while (offset < text.length) {
        const key = parseString()
        if (keys.has(key)) return invalid()
        keys.add(key)
        skipWhitespace()
        if (text[offset] !== ':') return invalid()
        offset += 1
        parseValue(depth + 1)
        skipWhitespace()
        if (text[offset] === '}') {
          offset += 1
          return
        }
        if (text[offset] !== ',') return invalid()
        offset += 1
        skipWhitespace()
      }
      return invalid()
    }
    if (token === '[') {
      offset += 1
      skipWhitespace()
      if (text[offset] === ']') {
        offset += 1
        return
      }
      while (offset < text.length) {
        parseValue(depth + 1)
        skipWhitespace()
        if (text[offset] === ']') {
          offset += 1
          return
        }
        if (text[offset] !== ',') return invalid()
        offset += 1
      }
      return invalid()
    }
    if (token === '"') {
      parseString()
      return
    }
    if (token === 't') return parseLiteral('true')
    if (token === 'f') return parseLiteral('false')
    if (token === 'n') return parseLiteral('null')
    const number = text.slice(offset).match(JSON_NUMBER_RE)?.[0]
    if (!number) return invalid()
    offset += number.length
  }

  try {
    skipWhitespace()
    parseValue(0)
    skipWhitespace()
    if (offset !== text.length) return invalid()
    return JSON.parse(text)
  } catch {
    return invalid()
  }
}
