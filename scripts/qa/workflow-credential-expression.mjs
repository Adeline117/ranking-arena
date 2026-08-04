const safeGithubRoots = new Set(['event_name', 'ref', 'sha'])

function isIdentifierStart(character) {
  return character !== undefined && /[A-Za-z_]/.test(character)
}

function isIdentifierPart(character) {
  return character !== undefined && /[A-Za-z0-9_]/.test(character)
}

function expressionHasCredentialContext(expression) {
  let quote = null

  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index]

    if (quote !== null) {
      if (character === quote) {
        if (expression[index + 1] === quote) {
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }

    if (character === "'" || character === '"') {
      quote = character
      continue
    }

    if (!isIdentifierStart(character)) continue

    let end = index + 1
    while (isIdentifierPart(expression[end])) end += 1
    const identifier = expression.slice(index, end).toLowerCase()

    if (identifier === 'secrets') return true

    if (identifier === 'github') {
      let propertyStart = end
      while (/\s/.test(expression[propertyStart] ?? '')) propertyStart += 1
      if (expression[propertyStart] !== '.') return true

      propertyStart += 1
      while (/\s/.test(expression[propertyStart] ?? '')) propertyStart += 1
      if (!isIdentifierStart(expression[propertyStart])) return true

      let propertyEnd = propertyStart + 1
      while (isIdentifierPart(expression[propertyEnd])) propertyEnd += 1
      const root = expression.slice(propertyStart, propertyEnd).toLowerCase()
      if (!safeGithubRoots.has(root)) return true

      index = propertyEnd - 1
      continue
    }

    index = end - 1
  }

  // Invalid or truncated expressions fail conservatively.
  return quote !== null
}

function githubExpressions(value) {
  const source = typeof value === 'string' ? value : JSON.stringify(value)
  const expressions = []
  let cursor = 0

  while (cursor < source.length) {
    const start = source.indexOf('${{', cursor)
    if (start === -1) break

    let quote = null
    let closed = false

    for (let index = start + 3; index < source.length - 1; index += 1) {
      const character = source[index]

      if (quote !== null) {
        if (character === quote) {
          // GitHub expressions escape a quote inside a string by doubling it.
          if (source[index + 1] === quote) {
            index += 1
          } else {
            quote = null
          }
        }
        continue
      }

      if (character === "'" || character === '"') {
        quote = character
        continue
      }

      if (character === '}' && source[index + 1] === '}') {
        expressions.push(source.slice(start + 3, index))
        cursor = index + 2
        closed = true
        break
      }
    }

    if (!closed) {
      // Fail conservatively for malformed/truncated expressions instead of
      // letting a credential context disappear behind a parser edge case.
      expressions.push(source.slice(start + 3))
      break
    }
  }

  return expressions
}

export function hasCredentialExpression(value) {
  return githubExpressions(value).some(expressionHasCredentialContext)
}
