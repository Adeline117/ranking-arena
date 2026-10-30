const APP_SCHEMA_MODE = 'app-schema'
const FOUNDATION_MODE = 'foundation'
const REPLAY_INPUT_MODE = 'replay-input'

export const BASELINE_SQL_SAFETY_MODES = Object.freeze({
  APP_SCHEMA: APP_SCHEMA_MODE,
  FOUNDATION: FOUNDATION_MODE,
  REPLAY_INPUT: REPLAY_INPUT_MODE,
})

// PostgreSQL 17 pg_dump stores the random restriction key in a 64-byte C
// buffer, leaving 63 printable characters plus the terminating NUL.
const RESTRICTION_TOKEN_PATTERN = /^[0-9A-Za-z]{63}$/u
const APP_OWNED_SCHEMAS = new Set(['ARENA', 'PUBLIC'])
const DATA_OR_EXECUTION_HEADS = new Set([
  'CALL',
  'COPY',
  'DELETE',
  'DO',
  'INSERT',
  'MERGE',
  'TRUNCATE',
  'UPDATE',
  'VALUES',
  'WITH',
])
const QUERY_WRAPPER_HEADS = new Set([
  'DECLARE',
  'EXECUTE',
  'EXPLAIN',
  'FETCH',
  'MOVE',
  'PREPARE',
  'TABLE',
])
const APP_SCHEMA_STATEMENT_HEADS = new Set(['ALTER', 'COMMENT', 'CREATE', 'GRANT', 'REVOKE', 'SET'])
const TRANSACTION_HEADS = new Set(['ABORT', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT'])
const GLOBAL_CREATE_OBJECTS = new Set([
  'DATABASE',
  'GROUP',
  'ROLE',
  'SUBSCRIPTION',
  'TABLESPACE',
  'USER',
])
const MANAGED_SCHEMAS = new Set([
  'AUTH',
  'CRON',
  'EXTENSIONS',
  'GRAPHQL_PUBLIC',
  'INFORMATION_SCHEMA',
  'NET',
  'PGBOUNCER',
  'PGSODIUM',
  'PG_CATALOG',
  'PG_TEMP',
  'PG_TOAST',
  'REALTIME',
  'STORAGE',
  'SUPABASE_MIGRATIONS',
  'VAULT',
])
const SAFE_FOUNDATION_ROLES = new Set(['ANON', 'AUTHENTICATED', 'AUTHENTICATOR', 'SERVICE_ROLE'])
const SAFE_FUNCTION_LANGUAGES = new Set(['PLPGSQL', 'SQL'])
const FOUNDATION_CREATE_OBJECTS = new Set([
  'DOMAIN',
  'EXTENSION',
  'FUNCTION',
  'PROCEDURE',
  'ROLE',
  'SCHEMA',
  'SEQUENCE',
  'TABLE',
  'TYPE',
])
const SAFE_PG_DUMP_SETTINGS = new Map([
  ['CHECK_FUNCTION_BODIES', 'FALSE'],
  ['CLIENT_ENCODING', 'UTF8'],
  ['CLIENT_MIN_MESSAGES', 'WARNING'],
  ['DEFAULT_TABLE_ACCESS_METHOD', 'HEAP'],
  ['DEFAULT_TABLESPACE', ''],
  ['IDLE_IN_TRANSACTION_SESSION_TIMEOUT', '0'],
  ['LOCK_TIMEOUT', '0'],
  ['ROW_SECURITY', 'OFF'],
  ['STANDARD_CONFORMING_STRINGS', 'ON'],
  ['STATEMENT_TIMEOUT', '0'],
  ['TRANSACTION_TIMEOUT', '0'],
  ['XMLOPTION', 'CONTENT'],
])
const DANGEROUS_SERVER_FUNCTIONS = new Set([
  'DBLINK_CONNECT',
  'DBLINK_CONNECT_U',
  'DBLINK_EXEC',
  'DBLINK',
  'DBLINK_FETCH',
  'DBLINK_OPEN',
  'LO_EXPORT',
  'LO_IMPORT',
  'LOREAD',
  'LOWRITE',
  'PG_BACKUP_START',
  'PG_BACKUP_STOP',
  'PG_CANCEL_BACKEND',
  'PG_CREATE_RESTORE_POINT',
  'PG_LOG_BACKEND_MEMORY_CONTEXTS',
  'PG_FILE_RENAME',
  'PG_FILE_UNLINK',
  'PG_FILE_WRITE',
  'PG_LS_ARCHIVE_STATUSDIR',
  'PG_LS_DIR',
  'PG_LS_LOGDIR',
  'PG_LS_TMPDIR',
  'PG_LS_WALDIR',
  'PG_PROMOTE',
  'PG_READ_BINARY_FILE',
  'PG_READ_FILE',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'PG_STAT_FILE',
  'PG_SWITCH_WAL',
  'PG_TERMINATE_BACKEND',
  'PG_WAL_REPLAY_PAUSE',
  'PG_WAL_REPLAY_RESUME',
  'PG_WRITE_FILE',
])
const EXECUTABLE_BODY_CLUSTER_OBJECTS = new Set([
  'ACCESS',
  'DATABASE',
  'EVENT',
  'EXTENSION',
  'GROUP',
  'LANGUAGE',
  'PROCEDURAL',
  'ROLE',
  'SERVER',
  'SUBSCRIPTION',
  'TABLESPACE',
  'TRANSFORM',
  'USER',
])
const GLOBAL_ACL_OBJECTS = new Set([
  'ACCESS METHOD',
  'DATABASE',
  'EVENT TRIGGER',
  'EXTENSION',
  'FOREIGN DATA WRAPPER',
  'FOREIGN SERVER',
  'LANGUAGE',
  'LARGE OBJECT',
  'PARAMETER',
  'PUBLICATION',
  'ROLE',
  'SERVER',
  'SUBSCRIPTION',
  'TABLESPACE',
])
const OBJECT_TYPE_PREFIXES = [
  ['FOREIGN', 'DATA', 'WRAPPER'],
  ['TEXT', 'SEARCH', 'CONFIGURATION'],
  ['TEXT', 'SEARCH', 'DICTIONARY'],
  ['TEXT', 'SEARCH', 'PARSER'],
  ['TEXT', 'SEARCH', 'TEMPLATE'],
  ['DEFAULT', 'PRIVILEGES'],
  ['EVENT', 'TRIGGER'],
  ['FOREIGN', 'TABLE'],
  ['LARGE', 'OBJECT'],
  ['MATERIALIZED', 'VIEW'],
  ['USER', 'MAPPING'],
  ['ACCESS', 'METHOD'],
  ['OPERATOR', 'CLASS'],
  ['OPERATOR', 'FAMILY'],
  ['PROCEDURAL', 'LANGUAGE'],
  ['AGGREGATE'],
  ['CAST'],
  ['COLLATION'],
  ['COLUMN'],
  ['CONSTRAINT'],
  ['CONVERSION'],
  ['DATABASE'],
  ['DOMAIN'],
  ['EXTENSION'],
  ['FUNCTION'],
  ['INDEX'],
  ['LANGUAGE'],
  ['OPERATOR'],
  ['POLICY'],
  ['PROCEDURE'],
  ['PUBLICATION'],
  ['ROLE'],
  ['ROUTINE'],
  ['RULE'],
  ['SCHEMA'],
  ['SEQUENCE'],
  ['SERVER'],
  ['STATISTICS'],
  ['SUBSCRIPTION'],
  ['TABLE'],
  ['TABLESPACE'],
  ['TRANSFORM'],
  ['TRIGGER'],
  ['TYPE'],
  ['USER'],
  ['VIEW'],
]

function fail(label, message) {
  throw new Error(`${label}: ${message}`)
}

function isWhitespace(character) {
  return character !== undefined && /\s/u.test(character)
}

function isWordStart(character) {
  if (character === undefined) return false
  return /[A-Za-z_]/u.test(character) || character.codePointAt(0) >= 0x80
}

function isWordContinuation(character) {
  return (
    character !== undefined &&
    (/[A-Za-z0-9_$]/u.test(character) || character.codePointAt(0) >= 0x80)
  )
}

function isDollarTagContinuation(character) {
  return (
    character !== undefined && (/[A-Za-z0-9_]/u.test(character) || character.codePointAt(0) >= 0x80)
  )
}

function decodeQuotedIdentifier(contents) {
  return contents.replaceAll('""', '"')
}

function decodeUnicodeQuotedIdentifier(contents, label) {
  let decoded = ''
  let index = 0

  while (index < contents.length) {
    const current = contents[index]
    if (current === '"' && contents[index + 1] === '"') {
      decoded += '"'
      index += 2
      continue
    }
    if (current !== '\\') {
      decoded += current
      index += 1
      continue
    }
    if (contents[index + 1] === '\\') {
      decoded += '\\'
      index += 2
      continue
    }

    const isLong = contents[index + 1] === '+'
    const digitStart = index + (isLong ? 2 : 1)
    const digitCount = isLong ? 6 : 4
    const digits = contents.slice(digitStart, digitStart + digitCount)
    if (!new RegExp(`^[0-9A-Fa-f]{${digitCount}}$`, 'u').test(digits)) {
      fail(label, 'invalid Unicode escape in quoted identifier')
    }
    const codePoint = Number.parseInt(digits, 16)
    if (codePoint === 0 || codePoint > 0x10ffff) {
      fail(label, 'invalid Unicode code point in quoted identifier')
    }
    decoded += String.fromCodePoint(codePoint)
    index = digitStart + digitCount
  }

  return decoded
}

function decodeStandardString(contents) {
  return contents.replaceAll("''", "'")
}

function scanQuoted(source, start, quote, { backslashEscapes = false, label, kind }) {
  let index = start + 1

  while (index < source.length) {
    const current = source[index]
    const next = source[index + 1]

    if (current === quote && next === quote) {
      index += 2
      continue
    }
    if (backslashEscapes && current === '\\') {
      if (next === undefined) fail(label, `unterminated ${kind}`)
      index += 2
      continue
    }
    if (current === quote) return index + 1
    index += 1
  }

  fail(label, `unterminated ${kind}`)
}

function dollarDelimiterAt(source, start) {
  if (source[start] !== '$') return null
  if (isWordContinuation(source[start - 1])) return null
  if (source[start + 1] === '$') return '$$'
  if (!isWordStart(source[start + 1])) return null

  let index = start + 2
  while (isDollarTagContinuation(source[index])) index += 1
  if (source[index] !== '$') return null
  return source.slice(start, index + 1)
}

function scanMetaCommand(source, start, label) {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  let lineEnd = source.indexOf('\n', start)
  if (lineEnd === -1) lineEnd = source.length
  const contentEnd = source[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd
  const line = source.slice(lineStart, contentEnd)
  const match = /^\\(restrict|unrestrict) ([0-9A-Za-z]{63})$/u.exec(line)

  if (!match || start !== lineStart || !RESTRICTION_TOKEN_PATTERN.test(match[2])) {
    fail(label, 'psql meta-commands are forbidden outside an exact restriction envelope')
  }

  return {
    end: lineEnd,
    kind: match[1],
    start: lineStart,
    token: match[2],
    type: 'meta',
  }
}

function lexSql(source, label) {
  const tokens = []
  let blockDepth = 0
  let index = 0

  if (source.includes('\0')) fail(label, 'NUL bytes are forbidden')

  while (index < source.length) {
    const current = source[index]
    const next = source[index + 1]

    if (isWhitespace(current)) {
      index += 1
      continue
    }

    if (current === '-' && next === '-') {
      const newline = source.indexOf('\n', index + 2)
      index = newline === -1 ? source.length : newline + 1
      continue
    }

    if (current === '/' && next === '*') {
      blockDepth = 1
      index += 2
      while (index < source.length && blockDepth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') {
          blockDepth += 1
          index += 2
        } else if (source[index] === '*' && source[index + 1] === '/') {
          blockDepth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      if (blockDepth !== 0) fail(label, 'unterminated block comment')
      continue
    }

    if (current === '\\') {
      const token = scanMetaCommand(source, index, label)
      tokens.push(token)
      index = token.end
      continue
    }

    if (
      (current === 'U' || current === 'u') &&
      next === '&' &&
      (source[index + 2] === "'" || source[index + 2] === '"')
    ) {
      const quote = source[index + 2]
      const end = scanQuoted(source, index + 2, quote, {
        label,
        kind: quote === "'" ? 'Unicode string literal' : 'Unicode quoted identifier',
      })
      tokens.push({
        end,
        kind: quote === "'" ? 'unicode' : 'unicode-identifier',
        start: index,
        type: quote === "'" ? 'string' : 'quoted-identifier',
        value:
          quote === "'"
            ? decodeStandardString(source.slice(index + 3, end - 1))
            : decodeUnicodeQuotedIdentifier(source.slice(index + 3, end - 1), label),
      })
      index = end
      continue
    }

    if (
      (current === 'E' || current === 'e') &&
      next === "'" &&
      !isWordContinuation(source[index - 1])
    ) {
      const end = scanQuoted(source, index + 1, "'", {
        backslashEscapes: true,
        label,
        kind: 'escape string literal',
      })
      tokens.push({
        end,
        kind: 'escape',
        start: index,
        type: 'string',
        value: source.slice(index + 2, end - 1),
      })
      index = end
      continue
    }

    if (
      (current === 'B' ||
        current === 'b' ||
        current === 'N' ||
        current === 'n' ||
        current === 'X' ||
        current === 'x') &&
      next === "'" &&
      !isWordContinuation(source[index - 1])
    ) {
      const end = scanQuoted(source, index + 1, "'", {
        label,
        kind: 'prefixed string literal',
      })
      tokens.push({
        end,
        kind: 'prefixed',
        start: index,
        type: 'string',
        value: decodeStandardString(source.slice(index + 2, end - 1)),
      })
      index = end
      continue
    }

    if (current === "'") {
      const end = scanQuoted(source, index, "'", {
        label,
        kind: 'string literal',
      })
      tokens.push({
        end,
        kind: 'standard',
        start: index,
        type: 'string',
        value: decodeStandardString(source.slice(index + 1, end - 1)),
      })
      index = end
      continue
    }

    if (current === '"') {
      const end = scanQuoted(source, index, '"', {
        label,
        kind: 'quoted identifier',
      })
      tokens.push({
        end,
        start: index,
        type: 'quoted-identifier',
        value: decodeQuotedIdentifier(source.slice(index + 1, end - 1)),
      })
      index = end
      continue
    }

    if (current === '$') {
      const delimiter = dollarDelimiterAt(source, index)
      if (delimiter) {
        const bodyStart = index + delimiter.length
        const close = source.indexOf(delimiter, bodyStart)
        if (close === -1) fail(label, `unterminated dollar-quoted body ${delimiter}`)
        const end = close + delimiter.length
        tokens.push({
          body: source.slice(bodyStart, close),
          end,
          kind: 'dollar',
          start: index,
          type: 'string',
        })
        index = end
        continue
      }
    }

    if (isWordStart(current)) {
      let end = index + 1
      while (isWordContinuation(source[end])) end += 1
      const text = source.slice(index, end)
      tokens.push({ end, start: index, text, type: 'word', upper: text.toUpperCase() })
      index = end
      continue
    }

    if (/[0-9]/u.test(current)) {
      let end = index + 1
      while (/[0-9A-Za-z_.]/u.test(source[end] ?? '')) end += 1
      tokens.push({ end, start: index, text: source.slice(index, end), type: 'number' })
      index = end
      continue
    }

    tokens.push({ end: index + 1, start: index, text: current, type: 'symbol' })
    index += 1
  }

  return tokens
}

function validateRestrictionEnvelope(tokens, label) {
  const commands = tokens.filter((token) => token.type === 'meta')
  if (commands.length === 0) return null

  if (
    commands.length !== 2 ||
    commands[0].kind !== 'restrict' ||
    commands[1].kind !== 'unrestrict' ||
    commands[0].token !== commands[1].token
  ) {
    fail(label, 'restriction envelope must contain one matching restrict/unrestrict pair')
  }

  const sqlTokens = tokens.filter((token) => token.type !== 'meta')
  if (sqlTokens.some((token) => token.start < commands[0].start)) {
    fail(label, 'the restrict command must precede every SQL token')
  }
  if (sqlTokens.some((token) => token.start >= commands[1].end)) {
    fail(label, 'the unrestrict command must follow every SQL token')
  }

  return commands[0].token
}

function splitStatements(tokens) {
  const statements = []
  let current = []

  for (const token of tokens) {
    if (token.type === 'meta') continue
    if (token.type === 'symbol' && token.text === ';') {
      if (current.length > 0) statements.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  if (current.length > 0) statements.push(current)
  return statements
}

function assertBalancedParentheses(tokens, label) {
  let depth = 0
  for (const token of tokens) {
    if (token.type !== 'symbol') continue
    if (token.text === '(') depth += 1
    if (token.text === ')') depth -= 1
    if (depth < 0) fail(label, 'unbalanced top-level parentheses')
  }
  if (depth !== 0) fail(label, 'unbalanced top-level parentheses')
}

function topLevelWords(tokens) {
  const words = []
  let depth = 0
  for (const token of tokens) {
    if (token.type === 'symbol' && token.text === '(') {
      depth += 1
      continue
    }
    if (token.type === 'symbol' && token.text === ')') {
      depth -= 1
      continue
    }
    if (depth === 0 && token.type === 'word') words.push(token.upper)
  }
  return words
}

function topLevelTokens(tokens) {
  const result = []
  let depth = 0
  for (const token of tokens) {
    if (token.type === 'symbol' && token.text === '(') {
      depth += 1
      continue
    }
    if (token.type === 'symbol' && token.text === ')') {
      depth -= 1
      continue
    }
    if (depth === 0) result.push(token)
  }
  return result
}

function identifierUpper(token) {
  if (token?.type === 'word') return token.upper
  if (token?.type === 'quoted-identifier') return token.value.toUpperCase()
  if (token?.type === 'string' && typeof token.value === 'string') {
    return token.value.toUpperCase()
  }
  return null
}

function isSymbol(token, symbol) {
  return token?.type === 'symbol' && token.text === symbol
}

function isAppOwnedSchemaIdentifier(token) {
  if (token?.type === 'word') return APP_OWNED_SCHEMAS.has(token.upper)
  if (token?.type === 'quoted-identifier') {
    return token.value === 'arena' || token.value === 'public'
  }
  return false
}

function qualifiedNameAt(tokens, index) {
  if (identifierUpper(tokens[index]) === null) return null
  if (!isSymbol(tokens[index + 1], '.') || identifierUpper(tokens[index + 2]) === null) {
    return { end: index + 1, qualified: false, schemaToken: null }
  }
  return { end: index + 3, qualified: true, schemaToken: tokens[index] }
}

function assertAppOwnedQualifiedName(tokens, index, label, context) {
  const name = qualifiedNameAt(tokens, index)
  if (!name?.qualified || !isAppOwnedSchemaIdentifier(name.schemaToken)) {
    fail(label, `${context} must be explicitly qualified in the public or arena schema`)
  }
  return name.end
}

function assertAppOwnedSchemaName(token, label, context) {
  if (!isAppOwnedSchemaIdentifier(token)) {
    fail(label, `${context} must target the public or arena schema`)
  }
}

function isManagedQualifiedName(tokens, index) {
  return MANAGED_SCHEMAS.has(identifierUpper(tokens[index])) && isSymbol(tokens[index + 1], '.')
}

function containsManagedQualifiedName(tokens, start = 0, end = tokens.length) {
  for (let index = start; index < end - 1; index += 1) {
    if (isManagedQualifiedName(tokens, index)) return true
  }
  return false
}

function findTopLevelWord(tokens, word, start = 0) {
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (isSymbol(token, '(')) {
      depth += 1
      continue
    }
    if (isSymbol(token, ')')) {
      depth -= 1
      continue
    }
    if (depth === 0 && token.type === 'word' && token.upper === word) return index
  }
  return -1
}

function matchesWordSequence(tokens, index, words) {
  return words.every(
    (word, offset) =>
      tokens[index + offset]?.type === 'word' && tokens[index + offset].upper === word
  )
}

function objectTypeAt(tokens, start) {
  for (const prefix of OBJECT_TYPE_PREFIXES) {
    if (matchesWordSequence(tokens, start, prefix)) {
      return { end: start + prefix.length, name: prefix.join(' ') }
    }
  }
  return null
}

function commandObject(tokens) {
  const flat = topLevelTokens(tokens)
  const verb = flat[0]?.type === 'word' ? flat[0].upper : null
  if (verb !== 'CREATE' && verb !== 'ALTER' && verb !== 'DROP') return null

  let index = 1
  if (verb === 'CREATE' && matchesWordSequence(flat, index, ['OR', 'REPLACE'])) index += 2
  if (verb === 'CREATE') {
    while (
      [
        'CONSTRAINT',
        'GLOBAL',
        'LOCAL',
        'RECURSIVE',
        'TEMP',
        'TEMPORARY',
        'TRUSTED',
        'UNIQUE',
        'UNLOGGED',
      ].includes(flat[index]?.upper)
    ) {
      index += 1
    }
  }
  const objectType = objectTypeAt(flat, index)
  if (!objectType) return { flat, nameIndex: -1, objectType: null, verb }
  index = objectType.end
  while (flat[index]?.upper === 'CONCURRENTLY' || flat[index]?.upper === 'ONLY') index += 1
  if (matchesWordSequence(flat, index, ['IF', 'NOT', 'EXISTS'])) index += 3
  else if (matchesWordSequence(flat, index, ['IF', 'EXISTS'])) index += 2
  while (flat[index]?.upper === 'CONCURRENTLY' || flat[index]?.upper === 'ONLY') index += 1

  return { flat, nameIndex: index, objectType: objectType.name, verb }
}

function assertNoDangerousServerCalls(tokens, label) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const functionName = identifierUpper(tokens[index])
    if (
      (DANGEROUS_SERVER_FUNCTIONS.has(functionName) ||
        functionName?.startsWith('DBLINK') ||
        functionName?.startsWith('LO_') ||
        functionName?.startsWith('PG_LS_')) &&
      isSymbol(tokens[index + 1], '(')
    ) {
      fail(label, `${functionName} is a forbidden server capability`)
    }
  }
}

function hasWordSequence(words, sequence) {
  for (let index = 0; index <= words.length - sequence.length; index += 1) {
    if (sequence.every((word, offset) => words[index + offset] === word)) return true
  }
  return false
}

function assertNoSystemCatalogDml(tokens, label) {
  const targetAfter = (index, requiredWord = null) => {
    let cursor = index + 1
    if (requiredWord !== null) {
      if (identifierUpper(tokens[cursor]) !== requiredWord) return null
      cursor += 1
    }
    if (identifierUpper(tokens[cursor]) === 'TABLE') cursor += 1
    if (identifierUpper(tokens[cursor]) === 'ONLY') cursor += 1
    return cursor
  }

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.type !== 'word') continue
    const word = identifierUpper(tokens[index])
    let target = null
    if (word === 'UPDATE') target = targetAfter(index)
    else if (word === 'INSERT' || word === 'MERGE') target = targetAfter(index, 'INTO')
    else if (word === 'DELETE') target = targetAfter(index, 'FROM')
    else if (word === 'TRUNCATE') target = targetAfter(index)
    if (target === null) continue

    const targetName = identifierUpper(tokens[target])
    const explicitlySystem = targetName === 'PG_CATALOG' && isSymbol(tokens[target + 1], '.')
    const implicitlySystem = targetName?.startsWith('PG_') && !isSymbol(tokens[target + 1], '.')
    if (explicitlySystem || implicitlySystem) {
      fail(label, 'system-catalog DML is forbidden in offline baseline replay')
    }
  }
}

function assertNoCapabilityText(text, label) {
  const words = text.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/gu) ?? []

  if (words.includes('COPY')) fail(label, 'COPY is forbidden inside executable SQL')
  if (hasWordSequence(words, ['ALTER', 'SYSTEM'])) {
    fail(label, 'ALTER SYSTEM is forbidden inside executable SQL')
  }
  if (
    hasWordSequence(words, ['IMPORT', 'FOREIGN', 'SCHEMA']) ||
    hasWordSequence(words, ['FOREIGN', 'DATA', 'WRAPPER']) ||
    hasWordSequence(words, ['USER', 'MAPPING'])
  ) {
    fail(label, 'foreign data operations are forbidden inside executable SQL')
  }
  if (words.includes('LOAD')) fail(label, 'LOAD is forbidden inside executable SQL')
  if (
    hasWordSequence(words, ['UPDATE', 'PG_CATALOG']) ||
    hasWordSequence(words, ['INSERT', 'INTO', 'PG_CATALOG']) ||
    hasWordSequence(words, ['DELETE', 'FROM', 'PG_CATALOG']) ||
    hasWordSequence(words, ['MERGE', 'INTO', 'PG_CATALOG']) ||
    hasWordSequence(words, ['TRUNCATE', 'PG_CATALOG']) ||
    hasWordSequence(words, ['TRUNCATE', 'TABLE', 'PG_CATALOG'])
  ) {
    fail(label, 'system-catalog DML is forbidden inside executable SQL')
  }

  for (let index = 0; index < words.length - 1; index += 1) {
    if (words[index] === 'CREATE' || words[index] === 'ALTER' || words[index] === 'DROP') {
      let objectIndex = index + 1
      if (
        words[index] === 'CREATE' &&
        words[objectIndex] === 'OR' &&
        words[objectIndex + 1] === 'REPLACE'
      ) {
        objectIndex += 2
      }
      while (
        words[index] === 'CREATE' &&
        ['GLOBAL', 'LOCAL', 'TEMP', 'TEMPORARY', 'TRUSTED', 'UNLOGGED'].includes(words[objectIndex])
      ) {
        objectIndex += 1
      }
      if (EXECUTABLE_BODY_CLUSTER_OBJECTS.has(words[objectIndex])) {
        fail(label, `${words[index]} ${words[objectIndex]} is forbidden inside executable SQL`)
      }
    }
    if (words[index] === 'LANGUAGE' && !SAFE_FUNCTION_LANGUAGES.has(words[index + 1])) {
      fail(label, `LANGUAGE ${words[index + 1]} is forbidden inside executable SQL`)
    }
  }

  for (const word of words) {
    if (
      DANGEROUS_SERVER_FUNCTIONS.has(word) ||
      word.startsWith('DBLINK') ||
      word.startsWith('LO_') ||
      word.startsWith('PG_LS_') ||
      word === 'LOREAD' ||
      word === 'LOWRITE'
    ) {
      fail(label, `${word} is a forbidden server capability inside executable SQL`)
    }
  }
}

function assertExecutableTokenCapabilities(tokens, label, depth = 0) {
  if (depth > 8) fail(label, 'executable SQL nesting is too deep to safety-scan')

  assertNoDangerousServerCalls(tokens, label)
  assertNoSystemCatalogDml(tokens, label)
  const words = tokens.filter((token) => token.type === 'word').map((token) => token.upper)
  assertNoCapabilityText(words.join(' '), label)

  for (const token of tokens) {
    const body = token.kind === 'dollar' ? token.body : null
    if (typeof body === 'string') {
      assertExecutableTokenCapabilities(lexSql(body, `${label} executable body`), label, depth + 1)
      continue
    }
    if (token.type === 'string' && typeof token.value === 'string') {
      // A string in an executable body can be dynamic SQL. This intentionally
      // errs on the side of rejection but cannot prove safety across arbitrary
      // runtime concatenation.
      assertNoCapabilityText(token.value, label)
    }
  }
}

function assertNoExecutableBodyCapabilities(tokens, label) {
  const words = topLevelWords(tokens)
  const command = commandObject(tokens)
  const isDo = words[0] === 'DO'
  const isRoutine =
    command?.verb === 'CREATE' &&
    (command.objectType === 'FUNCTION' || command.objectType === 'PROCEDURE')
  if (!isDo && !isRoutine) return

  let foundBody = false
  for (const token of tokens) {
    if (token.kind === 'dollar' && typeof token.body === 'string') {
      foundBody = true
      assertExecutableTokenCapabilities(lexSql(token.body, `${label} executable body`), label)
    }
  }

  if (foundBody) return

  const bodyStart = isDo ? 1 : findTopLevelWord(tokens, 'AS', 1) + 1
  if (bodyStart <= 0) return
  for (let index = bodyStart; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type === 'string' && typeof token.value === 'string') {
      assertExecutableTokenCapabilities(lexSql(token.value, `${label} executable body`), label)
      return
    }
  }
}

function isSafeFoundationRoleCreation(tokens) {
  const command = commandObject(tokens)
  if (command?.verb !== 'CREATE' || command.objectType !== 'ROLE') return false
  const role = identifierUpper(command.flat[command.nameIndex])
  if (!SAFE_FOUNDATION_ROLES.has(role)) return false
  const allowedOptions = new Set([
    'CREATE',
    'ROLE',
    role,
    'WITH',
    'NOLOGIN',
    'NOSUPERUSER',
    'NOCREATEDB',
    'NOCREATEROLE',
    'NOREPLICATION',
    'NOBYPASSRLS',
    'INHERIT',
    'NOINHERIT',
  ])
  return command.flat.every((token) => {
    const value = identifierUpper(token)
    return value === null || allowedOptions.has(value)
  })
}

function assertNoClusterOrOutboundOperations(
  tokens,
  label,
  { allowFoundationExtensions = false, allowFoundationRoles = false } = {}
) {
  const words = topLevelWords(tokens)
  const head = words[0]
  const command = commandObject(tokens)
  if (head === 'LOAD') fail(label, 'LOAD is forbidden')
  if (head === 'IMPORT') fail(label, 'IMPORT is forbidden')
  if (head === 'COPY') fail(label, 'COPY is forbidden in offline baseline replay')
  if ((head === 'GRANT' || head === 'REVOKE') && !words.includes('ON')) {
    fail(label, 'database role-membership changes are forbidden in offline baseline replay')
  }
  if (head === 'ALTER' && words[1] === 'SYSTEM') fail(label, 'ALTER SYSTEM is forbidden')
  if (
    command?.verb === 'CREATE' &&
    (command.objectType === 'FUNCTION' || command.objectType === 'PROCEDURE')
  ) {
    const languageIndex = findTopLevelWord(tokens, 'LANGUAGE', 1)
    const language = languageIndex >= 0 ? identifierUpper(tokens[languageIndex + 1]) : null
    if (language !== null && !SAFE_FUNCTION_LANGUAGES.has(language)) {
      fail(label, `function language ${language} is forbidden in offline baseline replay`)
    }
  }
  if (head === 'DO') {
    const languageIndex = findTopLevelWord(tokens, 'LANGUAGE', 1)
    const language = languageIndex >= 0 ? identifierUpper(tokens[languageIndex + 1]) : 'PLPGSQL'
    if (!SAFE_FUNCTION_LANGUAGES.has(language)) {
      fail(label, `DO language ${language ?? '<unknown>'} is forbidden in offline baseline replay`)
    }
  }
  if (
    command?.objectType === 'EXTENSION' &&
    !(allowFoundationExtensions && command.verb === 'CREATE')
  ) {
    fail(label, 'extension DDL is forbidden outside the pinned foundation')
  }
  if (
    ['ACCESS METHOD', 'EVENT TRIGGER', 'LANGUAGE', 'PROCEDURAL LANGUAGE', 'TRANSFORM'].includes(
      command?.objectType
    )
  ) {
    fail(label, `${command.objectType} is a forbidden cluster capability`)
  }
  if (
    (head === 'CREATE' || head === 'ALTER' || head === 'DROP') &&
    GLOBAL_CREATE_OBJECTS.has(words[1])
  ) {
    if (allowFoundationRoles && isSafeFoundationRoleCreation(tokens)) {
      assertNoDangerousServerCalls(tokens, label)
      return
    }
    fail(label, `${head} ${words[1]} is forbidden`)
  }
  if (
    (head === 'CREATE' || head === 'ALTER' || head === 'DROP') &&
    (matchesWordSequence(tokens, 1, ['FOREIGN', 'DATA', 'WRAPPER']) ||
      matchesWordSequence(tokens, 1, ['FOREIGN', 'TABLE']) ||
      matchesWordSequence(tokens, 1, ['USER', 'MAPPING']) ||
      words[1] === 'SERVER')
  ) {
    fail(label, 'foreign data and server objects are forbidden')
  }
  assertNoDangerousServerCalls(tokens, label)
}

function isTransactionControl(tokens) {
  const words = topLevelWords(tokens)
  const head = words[0]
  if (TRANSACTION_HEADS.has(head)) return true
  if (head === 'RELEASE' && words[1] === 'SAVEPOINT') return true
  if (head === 'START' && words[1] === 'TRANSACTION') return true
  if (head === 'PREPARE' && words[1] === 'TRANSACTION') return true
  if (head !== 'SET') return false

  return (
    words[1] === 'TRANSACTION' ||
    ((words[1] === 'LOCAL' || words[1] === 'SESSION') && words[2] === 'TRANSACTION') ||
    (words[1] === 'SESSION' &&
      words[2] === 'CHARACTERISTICS' &&
      words[3] === 'AS' &&
      words[4] === 'TRANSACTION')
  )
}

function assertReplayCompatible(tokens, label, options = {}) {
  assertBalancedParentheses(tokens, label)
  if (tokens.some((token) => token.type === 'word' && token.upper === 'CONCURRENTLY')) {
    fail(label, 'CONCURRENTLY is incompatible with single-transaction replay')
  }
  if (isTransactionControl(tokens)) {
    fail(label, 'transaction control is forbidden inside single-transaction replay')
  }
  assertNoSystemCatalogDml(tokens, label)
  assertNoExecutableBodyCapabilities(tokens, label)
  assertNoClusterOrOutboundOperations(tokens, label, options)
}

function assertAdditiveFoundationStatement(tokens, label) {
  const words = topLevelWords(tokens)
  const command = commandObject(tokens)
  if (words[0] !== 'CREATE' || command?.verb !== 'CREATE') {
    fail(label, 'foundation fixtures may only add declarative CREATE objects')
  }
  if (words[1] === 'OR' && words[2] === 'REPLACE') {
    fail(label, 'foundation fixtures must not replace an existing object')
  }
  if (!FOUNDATION_CREATE_OBJECTS.has(command.objectType)) {
    fail(label, `foundation CREATE ${command.objectType ?? '<unknown>'} is not allowed`)
  }
  if (isCreateTableAs(words)) {
    fail(label, 'foundation CREATE TABLE AS is not allowed')
  }
}

function isAllowedSetConfig(tokens) {
  if (tokens.length !== 11) return false
  return (
    tokens[0].type === 'word' &&
    tokens[0].upper === 'SELECT' &&
    tokens[1].type === 'word' &&
    tokens[1].upper === 'PG_CATALOG' &&
    tokens[2].type === 'symbol' &&
    tokens[2].text === '.' &&
    tokens[3].type === 'word' &&
    tokens[3].upper === 'SET_CONFIG' &&
    tokens[4].type === 'symbol' &&
    tokens[4].text === '(' &&
    tokens[5].type === 'string' &&
    tokens[5].value === 'search_path' &&
    tokens[6].type === 'symbol' &&
    tokens[6].text === ',' &&
    tokens[7].type === 'string' &&
    tokens[7].value === '' &&
    tokens[8].type === 'symbol' &&
    tokens[8].text === ',' &&
    tokens[9].type === 'word' &&
    tokens[9].upper === 'FALSE' &&
    tokens[10].type === 'symbol' &&
    tokens[10].text === ')'
  )
}

function createObjectWords(words) {
  if (words[0] !== 'CREATE') return []
  let index = 1
  if (words[index] === 'OR' && words[index + 1] === 'REPLACE') index += 2
  while (
    words[index] === 'GLOBAL' ||
    words[index] === 'LOCAL' ||
    words[index] === 'TEMP' ||
    words[index] === 'TEMPORARY' ||
    words[index] === 'UNLOGGED'
  ) {
    index += 1
  }
  return words.slice(index)
}

function isCreateTableAs(words) {
  const objectWords = createObjectWords(words)
  return objectWords[0] === 'TABLE' && objectWords.slice(1).includes('AS')
}

function isMaterializedViewWithData(words) {
  const objectWords = createObjectWords(words)
  if (objectWords[0] !== 'MATERIALIZED' || objectWords[1] !== 'VIEW') return false
  return words.slice(-3).join(' ') !== 'WITH NO DATA'
}

function assertCommaSeparatedAppSchemas(tokens, start, end, label, context) {
  let index = start
  let count = 0
  while (index < end) {
    if (isSymbol(tokens[index], ',')) {
      index += 1
      continue
    }
    assertAppOwnedSchemaName(tokens[index], label, context)
    count += 1
    index += 1
  }
  if (count === 0) fail(label, `${context} must name the public or arena schema`)
}

function assertCommaSeparatedAppObjects(tokens, start, end, label, context) {
  let index = start
  let count = 0
  while (index < end) {
    if (isSymbol(tokens[index], ',')) {
      index += 1
      continue
    }
    index = assertAppOwnedQualifiedName(tokens, index, label, context)
    count += 1
  }
  if (count === 0) fail(label, `${context} must name an app-owned object`)
}

function assertAppOwnedAclTargets(tokens, label) {
  const flat = topLevelTokens(tokens)
  const onIndex = flat.findIndex((token) => token.type === 'word' && token.upper === 'ON')
  if (onIndex < 0) fail(label, 'database/global role-membership ACL changes are forbidden')
  const endIndex = flat.findIndex(
    (token, index) =>
      index > onIndex && token.type === 'word' && (token.upper === 'TO' || token.upper === 'FROM')
  )
  if (endIndex < 0) fail(label, 'ACL target list is malformed')

  let index = onIndex + 1
  if (
    flat[index]?.upper === 'ALL' &&
    ['FUNCTIONS', 'PROCEDURES', 'ROUTINES', 'SEQUENCES', 'TABLES'].includes(
      flat[index + 1]?.upper
    ) &&
    flat[index + 2]?.upper === 'IN' &&
    flat[index + 3]?.upper === 'SCHEMA'
  ) {
    assertCommaSeparatedAppSchemas(flat, index + 4, endIndex, label, 'ACL schema target')
    return
  }

  let objectType = null
  if (matchesWordSequence(flat, index, ['FOREIGN', 'DATA', 'WRAPPER'])) {
    objectType = 'FOREIGN DATA WRAPPER'
    index += 3
  } else if (matchesWordSequence(flat, index, ['FOREIGN', 'SERVER'])) {
    objectType = 'FOREIGN SERVER'
    index += 2
  } else {
    const parsedType = objectTypeAt(flat, index)
    if (parsedType) {
      objectType = parsedType.name
      index = parsedType.end
    }
  }

  if (GLOBAL_ACL_OBJECTS.has(objectType)) {
    fail(label, `${objectType} ACL changes are database/global and forbidden`)
  }
  if (objectType === 'SCHEMA') {
    assertCommaSeparatedAppSchemas(flat, index, endIndex, label, 'ACL schema target')
    return
  }

  const supportedObjects = new Set([
    null,
    'DOMAIN',
    'FUNCTION',
    'PROCEDURE',
    'ROUTINE',
    'SEQUENCE',
    'TABLE',
    'TYPE',
  ])
  if (!supportedObjects.has(objectType)) {
    fail(label, `ACL object type ${objectType ?? '<unknown>'} is not app-owned`)
  }
  assertCommaSeparatedAppObjects(flat, index, endIndex, label, 'ACL object target')
}

function assertAppOwnedDefaultPrivileges(tokens, label) {
  const flat = topLevelTokens(tokens)
  const inIndex = flat.findIndex(
    (token, index) =>
      token.type === 'word' && token.upper === 'IN' && flat[index + 1]?.upper === 'SCHEMA'
  )
  if (inIndex < 0) {
    fail(label, 'database-wide default privileges are forbidden; IN SCHEMA is required')
  }
  const endIndex = flat.findIndex(
    (token, index) =>
      index > inIndex &&
      token.type === 'word' &&
      (token.upper === 'GRANT' || token.upper === 'REVOKE')
  )
  if (endIndex < 0) fail(label, 'default privileges target is malformed')
  assertCommaSeparatedAppSchemas(
    flat,
    inIndex + 2,
    endIndex,
    label,
    'default privileges schema target'
  )
}

function assertAppOwnedCommentTarget(tokens, label) {
  const flat = topLevelTokens(tokens)
  const onIndex = flat.findIndex((token) => token.type === 'word' && token.upper === 'ON')
  const type = objectTypeAt(flat, onIndex + 1)
  if (!type) fail(label, 'COMMENT target type cannot be established as app-owned')
  if (GLOBAL_ACL_OBJECTS.has(type.name) || type.name === 'CAST' || type.name === 'TRANSFORM') {
    fail(label, `${type.name} metadata is database/global and forbidden`)
  }

  let targetIndex = type.end
  if (type.name === 'SCHEMA') {
    assertAppOwnedSchemaName(flat[targetIndex], label, 'COMMENT schema target')
    return
  }
  if (['CONSTRAINT', 'POLICY', 'RULE', 'TRIGGER'].includes(type.name)) {
    const secondOn = flat.findIndex(
      (token, index) => index > targetIndex && token.type === 'word' && token.upper === 'ON'
    )
    if (secondOn < 0) fail(label, `${type.name} COMMENT must identify its app-owned relation`)
    targetIndex = secondOn + 1
  }
  assertAppOwnedQualifiedName(flat, targetIndex, label, 'COMMENT object target')
}

function assertAppOwnedSecondaryRelationTargets(tokens, command, label) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      matchesWordSequence(tokens, index, ['PARTITION', 'OF']) ||
      matchesWordSequence(tokens, index, ['ATTACH', 'PARTITION']) ||
      matchesWordSequence(tokens, index, ['DETACH', 'PARTITION']) ||
      matchesWordSequence(tokens, index, ['OWNED', 'BY'])
    ) {
      const targetIndex = index + 2
      if (tokens[targetIndex]?.upper !== 'NONE') {
        assertAppOwnedQualifiedName(tokens, targetIndex, label, 'secondary relation target')
      }
    }

    if (
      command?.objectType === 'TABLE' &&
      tokens[index]?.type === 'word' &&
      tokens[index].upper === 'INHERIT'
    ) {
      assertAppOwnedQualifiedName(tokens, index + 1, label, 'inherited relation target')
    }

    if (tokens[index]?.type === 'word' && tokens[index].upper === 'INHERITS') {
      let cursor = index + 1
      if (!isSymbol(tokens[cursor], '(')) fail(label, 'INHERITS target list is malformed')
      cursor += 1
      while (cursor < tokens.length && !isSymbol(tokens[cursor], ')')) {
        if (isSymbol(tokens[cursor], ',')) {
          cursor += 1
          continue
        }
        cursor = assertAppOwnedQualifiedName(tokens, cursor, label, 'inherited relation target')
      }
      if (!isSymbol(tokens[cursor], ')')) fail(label, 'INHERITS target list is malformed')
    }

    if (matchesWordSequence(tokens, index, ['SET', 'SCHEMA'])) {
      assertAppOwnedSchemaName(tokens[index + 2], label, 'SET SCHEMA destination')
    }
  }
}

function assertAppOwnedMutationTargets(tokens, label) {
  const words = topLevelWords(tokens)
  if (words[0] === 'GRANT' || words[0] === 'REVOKE') {
    assertAppOwnedAclTargets(tokens, label)
    return
  }
  if (words[0] === 'COMMENT') {
    assertAppOwnedCommentTarget(tokens, label)
    return
  }
  if (words[0] === 'ALTER' && words[1] === 'DEFAULT' && words[2] === 'PRIVILEGES') {
    assertAppOwnedDefaultPrivileges(tokens, label)
    return
  }
  if (words[0] === 'SET' || words[0] === 'SELECT') return

  const command = commandObject(tokens)
  if (!command?.objectType || command.nameIndex < 0) {
    fail(label, 'DDL mutation target cannot be established as app-owned')
  }
  if (command.verb === 'ALTER' && words.includes('RESTART')) {
    fail(label, 'sequence and identity RESTART operations are forbidden')
  }
  if (command.objectType === 'PUBLICATION') {
    fail(label, 'PUBLICATION DDL is database-global and forbidden')
  }
  if (command.objectType === 'SCHEMA') {
    assertAppOwnedSchemaName(command.flat[command.nameIndex], label, 'schema mutation')
  } else if (command.objectType === 'INDEX' && command.verb === 'CREATE') {
    const onIndex = command.flat.findIndex(
      (token, index) => index > command.nameIndex && token.type === 'word' && token.upper === 'ON'
    )
    if (onIndex < 0) fail(label, 'CREATE INDEX must identify its app-owned relation')
    let targetIndex = onIndex + 1
    if (command.flat[targetIndex]?.upper === 'ONLY') targetIndex += 1
    assertAppOwnedQualifiedName(command.flat, targetIndex, label, 'index relation target')
    if (qualifiedNameAt(command.flat, command.nameIndex)?.qualified) {
      assertAppOwnedQualifiedName(command.flat, command.nameIndex, label, 'index object target')
    }
  } else if (['POLICY', 'TRIGGER'].includes(command.objectType)) {
    const onIndex = command.flat.findIndex(
      (token, index) => index > command.nameIndex && token.type === 'word' && token.upper === 'ON'
    )
    if (onIndex < 0) fail(label, `${command.objectType} must identify its app-owned relation`)
    assertAppOwnedQualifiedName(
      command.flat,
      onIndex + 1,
      label,
      `${command.objectType} relation target`
    )
  } else if (command.objectType === 'RULE') {
    const toIndex = command.flat.findIndex(
      (token, index) => index > command.nameIndex && token.type === 'word' && token.upper === 'TO'
    )
    if (toIndex < 0) fail(label, 'RULE must identify its app-owned relation')
    assertAppOwnedQualifiedName(command.flat, toIndex + 1, label, 'RULE relation target')
  } else {
    assertAppOwnedQualifiedName(
      command.flat,
      command.nameIndex,
      label,
      `${command.objectType} mutation target`
    )
  }

  assertAppOwnedSecondaryRelationTargets(tokens, command, label)
}

function assertNoManagedSchemaMutation(tokens, label) {
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (
      identifierUpper(tokens[index]) === 'SUPABASE_MIGRATIONS' &&
      isSymbol(tokens[index + 1], '.') &&
      identifierUpper(tokens[index + 2]) === 'SCHEMA_MIGRATIONS'
    ) {
      fail(label, 'the Supabase migration ledger must not be referenced')
    }
    if (
      tokens[index].type === 'quoted-identifier' &&
      tokens[index].kind === 'unicode-identifier' &&
      tokens[index + 1]?.upper === 'UESCAPE'
    ) {
      fail(label, 'custom UESCAPE quoted identifiers are forbidden')
    }
  }

  const command = commandObject(tokens)
  if (command?.nameIndex >= 0) {
    const target = command.flat[command.nameIndex]
    if (
      (command.objectType === 'SCHEMA' && MANAGED_SCHEMAS.has(identifierUpper(target))) ||
      (command.objectType !== 'SCHEMA' && isManagedQualifiedName(command.flat, command.nameIndex))
    ) {
      fail(label, `DDL may not target the managed ${identifierUpper(target)} schema`)
    }

    if (command.verb === 'DROP') {
      if (
        containsManagedQualifiedName(command.flat, command.nameIndex) ||
        (command.objectType === 'SCHEMA' &&
          command.flat
            .slice(command.nameIndex)
            .some((token) => MANAGED_SCHEMAS.has(identifierUpper(token))))
      ) {
        fail(label, 'DROP may not target a managed schema object')
      }
    }

    if (['INDEX', 'POLICY', 'RULE', 'TRIGGER'].includes(command.objectType)) {
      const onIndex = command.flat.findIndex(
        (token, index) => index > command.nameIndex && token.type === 'word' && token.upper === 'ON'
      )
      if (onIndex >= 0) {
        let targetIndex = onIndex + 1
        if (command.flat[targetIndex]?.upper === 'ONLY') targetIndex += 1
        if (isManagedQualifiedName(command.flat, targetIndex)) {
          fail(label, `${command.objectType} may not target a managed schema object`)
        }
      }
    }

    const setIndex = command.flat.findIndex(
      (token, index) =>
        index > command.nameIndex &&
        token.type === 'word' &&
        token.upper === 'SET' &&
        command.flat[index + 1]?.upper === 'SCHEMA'
    )
    if (setIndex >= 0 && MANAGED_SCHEMAS.has(identifierUpper(command.flat[setIndex + 2]))) {
      fail(label, 'an object may not be moved into a managed schema')
    }
  }

  const words = topLevelWords(tokens)
  if (words[0] === 'ALTER' && words[1] === 'DEFAULT' && words[2] === 'PRIVILEGES') {
    const flat = topLevelTokens(tokens)
    for (let index = 0; index < flat.length - 1; index += 1) {
      if (
        flat[index]?.upper === 'SCHEMA' &&
        MANAGED_SCHEMAS.has(identifierUpper(flat[index + 1]))
      ) {
        fail(label, 'default privileges may not target a managed schema')
      }
    }
  }

  if (words[0] === 'GRANT' || words[0] === 'REVOKE') {
    const flat = topLevelTokens(tokens)
    const onIndex = flat.findIndex((token) => token.type === 'word' && token.upper === 'ON')
    if (onIndex >= 0) {
      const endIndex = flat.findIndex(
        (token, index) =>
          index > onIndex &&
          token.type === 'word' &&
          (token.upper === 'TO' || token.upper === 'FROM')
      )
      const targetEnd = endIndex === -1 ? flat.length : endIndex
      if (containsManagedQualifiedName(flat, onIndex + 1, targetEnd)) {
        fail(label, 'ACL changes may not target a managed schema object')
      }
      for (let index = onIndex + 1; index < targetEnd - 1; index += 1) {
        if (flat[index]?.upper === 'SCHEMA') {
          for (let target = index + 1; target < targetEnd; target += 1) {
            if (MANAGED_SCHEMAS.has(identifierUpper(flat[target]))) {
              fail(label, 'ACL changes may not target a managed schema')
            }
          }
        }
      }
    }
  }

  if (
    (words[0] === 'COMMENT' && words[1] === 'ON') ||
    (words[0] === 'SECURITY' && words.includes('ON'))
  ) {
    const flat = topLevelTokens(tokens)
    const onIndex = flat.findIndex((token) => token.type === 'word' && token.upper === 'ON')
    const type = objectTypeAt(flat, onIndex + 1)
    if (type) {
      let targetIndex = type.end
      if (type.name === 'SCHEMA' && MANAGED_SCHEMAS.has(identifierUpper(flat[targetIndex]))) {
        fail(label, 'metadata changes may not target a managed schema')
      }
      if (isManagedQualifiedName(flat, targetIndex)) {
        fail(label, 'metadata changes may not target a managed schema object')
      }
      if (['POLICY', 'RULE', 'TRIGGER'].includes(type.name)) {
        const secondOn = flat.findIndex(
          (token, index) => index > targetIndex && token.type === 'word' && token.upper === 'ON'
        )
        if (secondOn >= 0 && isManagedQualifiedName(flat, secondOn + 1)) {
          fail(label, 'metadata changes may not target a managed schema object')
        }
      }
    }
  }
}

function assertNoUnsafeAppSchemaCapabilities(tokens, label) {
  const command = commandObject(tokens)
  const forbiddenObjects = new Set([
    'EVENT TRIGGER',
    'EXTENSION',
    'FOREIGN DATA WRAPPER',
    'FOREIGN TABLE',
    'LANGUAGE',
    'LARGE OBJECT',
    'PROCEDURAL LANGUAGE',
    'SERVER',
    'USER MAPPING',
  ])
  if (command && forbiddenObjects.has(command.objectType)) {
    fail(label, `${command.objectType} DDL is forbidden in an app schema`)
  }

  if (
    command &&
    command.verb === 'CREATE' &&
    (command.objectType === 'FUNCTION' || command.objectType === 'PROCEDURE')
  ) {
    const languageIndex = findTopLevelWord(tokens, 'LANGUAGE', 1)
    if (languageIndex >= 0) {
      const language = identifierUpper(tokens[languageIndex + 1])
      if (!SAFE_FUNCTION_LANGUAGES.has(language)) {
        fail(label, `function language ${language ?? '<unknown>'} is forbidden`)
      }
    }
  }

  const words = topLevelWords(tokens)
  if ((words[0] === 'GRANT' || words[0] === 'REVOKE') && !words.includes('ON')) {
    fail(label, 'role-membership GRANT/REVOKE is forbidden')
  }
  if (
    (words[0] === 'GRANT' || words[0] === 'REVOKE' || words[0] === 'COMMENT') &&
    words.includes('LARGE') &&
    words.includes('OBJECT')
  ) {
    fail(label, 'large-object metadata and ACL changes are forbidden')
  }

  if (words[0] === 'SET') {
    const setting = identifierUpper(tokens[1])
    const separator = tokens[2]
    const value = identifierUpper(tokens[3]) ?? tokens[3]?.text ?? null
    if (
      tokens.length !== 4 ||
      !isSymbol(separator, '=') ||
      !SAFE_PG_DUMP_SETTINGS.has(setting) ||
      SAFE_PG_DUMP_SETTINGS.get(setting) !== value
    ) {
      fail(label, 'SET must match an exact PostgreSQL 17 schema-only pg_dump setting')
    }
  }
}

function assertAppSchemaStatement(tokens, label) {
  assertReplayCompatible(tokens, label)

  const head = tokens[0]
  if (head.type !== 'word') {
    fail(label, 'could not establish a safe SQL statement head')
  }
  if (head.upper === 'SELECT') {
    if (!isAllowedSetConfig(tokens)) {
      fail(label, 'top-level SELECT is forbidden except the exact pg_catalog.set_config form')
    }
    return
  }
  if (DATA_OR_EXECUTION_HEADS.has(head.upper)) {
    fail(label, `top-level ${head.upper} is forbidden in an app schema`)
  }
  if (QUERY_WRAPPER_HEADS.has(head.upper)) {
    fail(label, `top-level ${head.upper} can execute a query and is forbidden`)
  }
  if (!APP_SCHEMA_STATEMENT_HEADS.has(head.upper)) {
    fail(label, `top-level ${head.upper} is not in the app-schema statement allowlist`)
  }

  assertNoUnsafeAppSchemaCapabilities(tokens, label)
  assertNoManagedSchemaMutation(tokens, label)
  assertAppOwnedMutationTargets(tokens, label)

  const words = topLevelWords(tokens)
  if (isCreateTableAs(words)) fail(label, 'CREATE TABLE AS is forbidden')
  if (isMaterializedViewWithData(words)) {
    fail(label, 'materialized views must be declared WITH NO DATA')
  }
  if (words[0] === 'REFRESH' && words[1] === 'MATERIALIZED' && words[2] === 'VIEW') {
    fail(label, 'REFRESH MATERIALIZED VIEW is forbidden')
  }
  if (words[0] === 'ALTER' && words[1] === 'SYSTEM') {
    fail(label, 'ALTER SYSTEM is forbidden')
  }
  if (words[0] === 'CREATE' && GLOBAL_CREATE_OBJECTS.has(words[1])) {
    fail(label, `CREATE ${words[1]} is forbidden`)
  }
  if (words[0] === 'IMPORT' && words[1] === 'FOREIGN' && words[2] === 'SCHEMA') {
    fail(label, 'IMPORT FOREIGN SCHEMA is forbidden')
  }
}

export function validateBaselineSqlSafety(
  source,
  { label = 'baseline SQL', mode = APP_SCHEMA_MODE } = {}
) {
  if (typeof source !== 'string') fail(label, 'input must be a string')
  if (typeof label !== 'string' || label.length === 0) {
    throw new Error('baseline SQL safety label must be a non-empty string')
  }
  if (mode !== APP_SCHEMA_MODE && mode !== FOUNDATION_MODE && mode !== REPLAY_INPUT_MODE) {
    fail(label, `unknown SQL safety mode: ${mode}`)
  }

  // psql recognizes CR, LF, and CRLF as line boundaries. Canonicalizing them
  // before lexical analysis prevents a bare CR from hiding a following meta-command.
  const normalizedSource = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const tokens = lexSql(normalizedSource, label)
  const restrictionToken = validateRestrictionEnvelope(tokens, label)
  if (mode !== APP_SCHEMA_MODE && restrictionToken !== null) {
    fail(label, 'restriction envelopes are permitted only for the app-schema pg_dump artifact')
  }
  const statements = splitStatements(tokens)

  for (const statement of statements) {
    if (mode === APP_SCHEMA_MODE) assertAppSchemaStatement(statement, label)
    else if (mode === FOUNDATION_MODE) {
      if (topLevelWords(statement)[0] === 'DO') {
        fail(label, 'foundation fixtures must be declarative; DO is forbidden')
      }
      assertReplayCompatible(statement, label, {
        allowFoundationExtensions: true,
        allowFoundationRoles: true,
      })
      assertAdditiveFoundationStatement(statement, label)
    } else assertReplayCompatible(statement, label)
  }

  return Object.freeze({
    mode,
    restrictionToken,
    statementCount: statements.length,
  })
}

export function validateAppSchemaSqlSafety(source, options = {}) {
  return validateBaselineSqlSafety(source, { ...options, mode: APP_SCHEMA_MODE })
}

export function validateReplaySqlSafety(source, options = {}) {
  return validateBaselineSqlSafety(source, { ...options, mode: REPLAY_INPUT_MODE })
}

export function validateFoundationSqlSafety(source, options = {}) {
  return validateBaselineSqlSafety(source, { ...options, mode: FOUNDATION_MODE })
}
