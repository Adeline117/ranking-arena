#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS_PREFIX = 'supabase/migrations/'
export const REVIEWED_EXCEPTIONS_PATH = 'scripts/qa/migration-sql-safety-reviewed.json'
// Only rules whose finding is a judgement about intent may be waived after
// review. History rules (deleted, modified, renamed migrations) never are.
const REVIEWABLE_RULES = new Set(['drop'])
const REVIEWED_EXCEPTION_KEYS = ['count', 'path', 'review', 'rule', 'sha256']
const QUOTED_IDENTIFIER = String.raw`"(?:[^"]|"")+"`
const UNICODE_QUOTED_IDENTIFIER = String.raw`U&${QUOTED_IDENTIFIER}(?:\s+UESCAPE\s+'(?:[^']|'')+')?`
const UNQUOTED_IDENTIFIER = String.raw`[\p{L}_][\p{L}\p{N}\p{M}_$]*`
const IDENTIFIER = String.raw`(?:${UNICODE_QUOTED_IDENTIFIER}|${QUOTED_IDENTIFIER}|${UNQUOTED_IDENTIFIER})`
const MAX_DYNAMIC_SQL_DEPTH = 4
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const DANGEROUS_ALTER_PATTERNS = Object.freeze([
  {
    rule: 'alter-column-type',
    message: 'ALTER COLUMN TYPE requires explicit manual review',
    pattern: new RegExp(
      String.raw`\bALTER\s+(?:COLUMN\s+)?${IDENTIFIER}\s+(?:TYPE\b|SET\s+DATA\s+TYPE\b)`,
      'giu'
    ),
  },
  {
    rule: 'alter-rename',
    message: 'ALTER TABLE rename operations require explicit manual review',
    pattern: new RegExp(
      String.raw`\bRENAME\s+(?:(?:COLUMN\s+)?${IDENTIFIER}\s+TO\b|CONSTRAINT\b|TO\b)`,
      'giu'
    ),
  },
  {
    rule: 'alter-set-schema',
    message: 'ALTER TABLE SET SCHEMA requires explicit manual review',
    pattern: /\bSET\s+SCHEMA\b/giu,
  },
  {
    rule: 'alter-detach-partition',
    message: 'ALTER TABLE DETACH PARTITION requires explicit manual review',
    pattern: /\bDETACH\s+PARTITION\b/giu,
  },
  {
    rule: 'alter-disable-trigger',
    message: 'ALTER TABLE DISABLE TRIGGER requires explicit manual review',
    pattern: /\bDISABLE\s+TRIGGER\b/giu,
  },
])

function blankCharacter(character) {
  return character === '\n' || character === '\r' ? character : ' '
}

function dollarQuoteAt(source, index) {
  return source.slice(index).match(/^\$(?:[a-z_][a-z0-9_]*)?\$/iu)?.[0] ?? null
}

function isEscapeStringStart(source, quoteIndex) {
  const prefixIndex = quoteIndex - 1
  if (prefixIndex < 0 || !/[eE]/u.test(source[prefixIndex])) return false
  return prefixIndex === 0 || !/[a-z0-9_$]/iu.test(source[prefixIndex - 1])
}

function unicodeEscapePrefixLength(source, quoteIndex) {
  if (quoteIndex < 2 || source.slice(quoteIndex - 2, quoteIndex).toUpperCase() !== 'U&') return 0
  return quoteIndex === 2 || !/[a-z0-9_$]/iu.test(source[quoteIndex - 3]) ? 2 : 0
}

/**
 * Remove SQL comments while preserving offsets. Quoted content stays intact so
 * destructive dynamic SQL remains reviewable instead of becoming an escape.
 */
export function maskSqlComments(source) {
  const output = source.split('')
  let mode = 'normal'
  let blockDepth = 0
  let dollarTag = ''
  let backslashEscapes = false

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]

    if (mode === 'line-comment') {
      output[index] = blankCharacter(current)
      if (current === '\n') mode = 'normal'
      continue
    }

    if (mode === 'block-comment') {
      output[index] = blankCharacter(current)
      if (current === '/' && next === '*') {
        output[index + 1] = ' '
        blockDepth += 1
        index += 1
      } else if (current === '*' && next === '/') {
        output[index + 1] = ' '
        blockDepth -= 1
        index += 1
        if (blockDepth === 0) mode = 'normal'
      }
      continue
    }

    if (mode === 'single-quote') {
      if (backslashEscapes && current === '\\' && next !== undefined) {
        index += 1
      } else if (current === "'" && next === "'") {
        index += 1
      } else if (current === "'") {
        mode = 'normal'
      }
      continue
    }

    if (mode === 'double-quote') {
      if (current === '"' && next === '"') {
        index += 1
      } else if (current === '"') {
        mode = 'normal'
      }
      continue
    }

    if (mode === 'dollar-quote') {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1
        mode = 'normal'
      }
      continue
    }

    if (current === '-' && next === '-') {
      output[index] = ' '
      output[index + 1] = ' '
      index += 1
      mode = 'line-comment'
    } else if (current === '/' && next === '*') {
      output[index] = ' '
      output[index + 1] = ' '
      blockDepth = 1
      index += 1
      mode = 'block-comment'
    } else if (current === "'") {
      backslashEscapes = isEscapeStringStart(source, index)
      mode = 'single-quote'
    } else if (current === '"') {
      mode = 'double-quote'
    } else if (current === '$') {
      const tag = dollarQuoteAt(source, index)
      if (tag) {
        dollarTag = tag
        index += tag.length - 1
        mode = 'dollar-quote'
      }
    }
  }

  if (mode === 'block-comment') throw new Error('unterminated SQL block comment')
  if (mode === 'single-quote') throw new Error('unterminated SQL string literal')
  if (mode === 'double-quote') throw new Error('unterminated quoted SQL identifier')
  if (mode === 'dollar-quote') throw new Error(`unterminated SQL dollar quote ${dollarTag}`)

  return output.join('')
}

function splitTopLevel(source, separator) {
  const segments = []
  let start = 0
  let mode = 'normal'
  let dollarTag = ''
  let parentheses = 0
  let brackets = 0
  let backslashEscapes = false

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]

    if (mode === 'single-quote') {
      if (backslashEscapes && current === '\\' && next !== undefined) index += 1
      else if (current === "'" && next === "'") index += 1
      else if (current === "'") mode = 'normal'
      continue
    }
    if (mode === 'double-quote') {
      if (current === '"' && next === '"') index += 1
      else if (current === '"') mode = 'normal'
      continue
    }
    if (mode === 'dollar-quote') {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1
        mode = 'normal'
      }
      continue
    }

    if (current === "'") {
      backslashEscapes = isEscapeStringStart(source, index)
      mode = 'single-quote'
    } else if (current === '"') {
      mode = 'double-quote'
    } else if (current === '$') {
      const tag = dollarQuoteAt(source, index)
      if (tag) {
        dollarTag = tag
        index += tag.length - 1
        mode = 'dollar-quote'
      }
    } else if (current === '(') {
      parentheses += 1
    } else if (current === ')') {
      parentheses = Math.max(0, parentheses - 1)
    } else if (current === '[') {
      brackets += 1
    } else if (current === ']') {
      brackets = Math.max(0, brackets - 1)
    } else if (current === separator && parentheses === 0 && brackets === 0) {
      segments.push({ text: source.slice(start, index), offset: start })
      start = index + 1
    }
  }

  segments.push({ text: source.slice(start), offset: start })
  return segments.filter(({ text }) => text.trim().length > 0)
}

function maskStringLiteralContents(source) {
  const output = source.split('')
  let mode = 'normal'
  let dollarTag = ''
  let backslashEscapes = false

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]

    if (mode === 'single-quote') {
      output[index] = blankCharacter(current)
      if (backslashEscapes && current === '\\' && next !== undefined) {
        output[index + 1] = blankCharacter(next)
        index += 1
      } else if (current === "'" && next === "'") {
        output[index + 1] = ' '
        index += 1
      } else if (current === "'") {
        mode = 'normal'
      }
      continue
    }

    if (mode === 'double-quote') {
      if (current === '"' && next === '"') index += 1
      else if (current === '"') mode = 'normal'
      continue
    }

    if (mode === 'dollar-quote') {
      output[index] = blankCharacter(current)
      if (source.startsWith(dollarTag, index)) {
        for (let tagIndex = 0; tagIndex < dollarTag.length; tagIndex += 1) {
          output[index + tagIndex] = ' '
        }
        index += dollarTag.length - 1
        mode = 'normal'
      }
      continue
    }

    if (current === "'") {
      output[index] = ' '
      backslashEscapes = isEscapeStringStart(source, index)
      mode = 'single-quote'
    } else if (current === '"') {
      mode = 'double-quote'
    } else if (current === '$') {
      const tag = dollarQuoteAt(source, index)
      if (tag) {
        for (let tagIndex = 0; tagIndex < tag.length; tagIndex += 1) {
          output[index + tagIndex] = ' '
        }
        dollarTag = tag
        index += tag.length - 1
        mode = 'dollar-quote'
      }
    }
  }

  return output.join('')
}

function maskQuotedIdentifierContents(source) {
  const output = source.split('')
  let insideIdentifier = false

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]
    if (insideIdentifier) {
      output[index] = blankCharacter(current)
      if (current === '"' && next === '"') {
        output[index + 1] = ' '
        index += 1
      } else if (current === '"') {
        insideIdentifier = false
      }
    } else if (current === '"') {
      output[index] = ' '
      insideIdentifier = true
    }
  }

  return output.join('')
}

function normalizeIdentifier(identifier) {
  if (/^U&"/iu.test(identifier)) {
    return `unicode-quoted:${identifier.slice(2)}`
  }
  if (identifier.startsWith('"')) {
    const decoded = identifier.slice(1, -1).replaceAll('""', '"')
    return /^[a-z_][a-z0-9_$]*$/u.test(decoded) ? `plain:${decoded}` : `quoted:${decoded}`
  }
  return `plain:${identifier.toLowerCase()}`
}

function firstNotNullIndex(source) {
  const pattern = /\bNOT\s+NULL\b/giu
  for (const match of source.matchAll(pattern)) {
    if (!/\bIS\s*$/iu.test(source.slice(0, match.index))) return match.index
  }
  return -1
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function violation(source, pathName, index, rule, message) {
  const line = lineNumberAt(source, index)
  return {
    path: pathName,
    line,
    rule,
    message,
    snippet: source.split(/\r?\n/u)[line - 1]?.trim() ?? '',
  }
}

function findPatternViolations({ source, searchable, path: pathName, statement, rule }) {
  const findings = []
  for (const match of searchable.matchAll(rule.pattern)) {
    findings.push(
      violation(source, pathName, statement.offset + match.index, rule.rule, rule.message)
    )
  }
  return findings
}

function decodeEscapeCharacter(character) {
  if (character === 'n') return '\n'
  if (character === 'r') return '\r'
  if (character === 't') return '\t'
  if (character === 'b') return '\b'
  if (character === 'f') return '\f'
  return character
}

function findQuotedRegions(source) {
  const regions = []
  let mode = 'normal'

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]

    if (mode === 'double-quote') {
      if (current === '"' && next === '"') index += 1
      else if (current === '"') mode = 'normal'
      continue
    }

    if (current === "'") {
      const openingOffset = index
      const backslashEscapes = isEscapeStringStart(source, index)
      const prefixLength = backslashEscapes ? 1 : unicodeEscapePrefixLength(source, index)
      const contentOffset = index + 1
      const decoded = []
      const indexMap = []
      let cursor = contentOffset

      while (cursor < source.length) {
        const character = source[cursor]
        const following = source[cursor + 1]
        const rawOffset = cursor - contentOffset

        if (backslashEscapes && character === '\\' && following !== undefined) {
          decoded.push(decodeEscapeCharacter(following))
          indexMap.push(rawOffset)
          cursor += 2
        } else if (character === "'" && following === "'") {
          decoded.push("'")
          indexMap.push(rawOffset)
          cursor += 2
        } else if (character === "'") {
          break
        } else {
          decoded.push(character)
          indexMap.push(rawOffset)
          cursor += 1
        }
      }

      if (cursor >= source.length) throw new Error('unterminated SQL string literal')
      regions.push({
        kind: 'single',
        text: decoded.join(''),
        openingOffset,
        endOffset: cursor + 1,
        offset: contentOffset,
        escapePrefixLength: prefixLength,
        indexMap,
      })
      index = cursor
    } else if (current === '"') {
      mode = 'double-quote'
    } else if (current === '$') {
      const tag = dollarQuoteAt(source, index)
      if (!tag) continue

      const bodyOffset = index + tag.length
      const closingOffset = source.indexOf(tag, bodyOffset)
      if (closingOffset < 0) throw new Error(`unterminated SQL dollar quote ${tag}`)
      regions.push({
        kind: 'dollar',
        text: source.slice(bodyOffset, closingOffset),
        openingOffset: index,
        endOffset: closingOffset + tag.length,
        offset: bodyOffset,
        escapePrefixLength: 0,
        indexMap: null,
      })
      index = closingOffset + tag.length - 1
    }
  }

  return regions
}

function findProceduralBodies(statement, executableStatement) {
  const doStatement = /^\s*DO\b/iu.test(executableStatement)
  const routineStatement = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/iu.test(
    executableStatement
  )
  if (!doStatement && !routineStatement) return []

  const languageIdentifier = String.raw`(?:[a-z_][a-z0-9_$]*|"(?:[^"]|"")+")`
  const doPrefixPattern = new RegExp(
    String.raw`^\s*DO\b(?:\s+LANGUAGE\s+${languageIdentifier})?\s*$`,
    'iu'
  )

  return findQuotedRegions(statement.text).filter((region) => {
    const prefixEnd = region.openingOffset - region.escapePrefixLength
    const prefix = executableStatement.slice(0, prefixEnd)
    if (doStatement) return doPrefixPattern.test(prefix)
    return /\bAS\s*$/iu.test(prefix)
  })
}

function bodySourceOffset(body, decodedOffset) {
  return body.offset + (body.indexMap?.[decodedOffset] ?? decodedOffset)
}

function truncateViolation(source, pathName, index) {
  return violation(
    source,
    pathName,
    index,
    'truncate',
    'TRUNCATE operations require explicit manual review'
  )
}

function dynamicSqlReviewViolation(source, pathName, index) {
  return violation(
    source,
    pathName,
    index,
    'dynamic-sql-review',
    'procedural EXECUTE must be a single statically reviewable string literal'
  )
}

function encodedProceduralSqlReviewViolation(source, pathName, index) {
  return violation(
    source,
    pathName,
    index,
    'encoded-procedural-sql-review',
    'E/U& encoded procedural bodies require explicit manual review'
  )
}

function lineStartOffset(source, line) {
  let offset = 0
  for (let currentLine = 1; currentLine < line; currentLine += 1) {
    const newline = source.indexOf('\n', offset)
    if (newline < 0) return source.length
    offset = newline + 1
  }
  return offset
}

function mapDynamicFindings(source, pathName, statement, body, region, depth) {
  if (depth >= MAX_DYNAMIC_SQL_DEPTH) {
    throw new Error(`dynamic SQL nesting exceeds ${MAX_DYNAMIC_SQL_DEPTH} levels`)
  }

  return analyzeMigrationSql(region.text, pathName, depth + 1).map((finding) => {
    const nestedOffset = lineStartOffset(region.text, finding.line)
    const bodyOffset = bodySourceOffset(region, nestedOffset)
    const sourceOffset = statement.offset + bodySourceOffset(body, bodyOffset)
    return violation(source, pathName, sourceOffset, finding.rule, finding.message)
  })
}

function findProceduralViolations(source, pathName, statement, body, depth) {
  const findings = []
  const commentMaskedBody = maskSqlComments(body.text)
  const executableBody = maskQuotedIdentifierContents(maskStringLiteralContents(commentMaskedBody))
  const statementPattern =
    /(?:^|;|\bBEGIN(?:\s+ATOMIC)?\b|\b(?:THEN|ELSE|LOOP)\b)\s*(TRUNCATE)\b/gimu

  for (const match of executableBody.matchAll(statementPattern)) {
    const keywordOffset = match[0].search(/\bTRUNCATE\b/iu)
    findings.push(
      truncateViolation(
        source,
        pathName,
        statement.offset + bodySourceOffset(body, match.index + keywordOffset)
      )
    )
  }

  const executePattern = /\b(EXECUTE)\b/giu
  const quotedRegions = findQuotedRegions(commentMaskedBody)
  for (const execute of executableBody.matchAll(executePattern)) {
    const previousCode = executableBody.slice(0, execute.index).trimEnd()
    if (previousCode.endsWith('.')) continue

    const executeOffset = execute.index
    const tailOffset = executeOffset + execute[1].length
    const commandEnd = executableBody.indexOf(';', tailOffset)
    const tailEnd = commandEnd < 0 ? executableBody.length : commandEnd
    const commandTail = commentMaskedBody.slice(tailOffset, tailEnd)
    const staticPrefix = commandTail.match(/^\s*(?:IMMEDIATE\s+)?(?<parens>(?:\(\s*)*)/iu)
    const openingOffset = tailOffset + (staticPrefix?.[0].length ?? 0)
    const region = quotedRegions.find((candidate) => candidate.openingOffset === openingOffset)
    const openingParens = staticPrefix?.groups?.parens.match(/\(/gu)?.length ?? 0
    const afterLiteral = region ? commentMaskedBody.slice(region.endOffset, tailEnd) : ''
    const staticSuffixPattern = new RegExp(
      String.raw`^\s*(?:\)\s*){${openingParens}}(?:(?:INTO|USING)\b[\s\S]*)?$`,
      'iu'
    )
    const plainStaticLiteral =
      region &&
      (region.kind === 'dollar' || region.escapePrefixLength === 0) &&
      staticSuffixPattern.test(afterLiteral)

    if (!plainStaticLiteral) {
      findings.push(
        dynamicSqlReviewViolation(
          source,
          pathName,
          statement.offset + bodySourceOffset(body, executeOffset)
        )
      )
      continue
    }
    findings.push(...mapDynamicFindings(source, pathName, statement, body, region, depth))
  }

  return findings
}

function findTruncateViolations(source, pathName, statement, depth) {
  const findings = []
  const executableStatement = maskStringLiteralContents(statement.text)
  const direct = executableStatement.match(/^\s*(TRUNCATE)\b/iu)
  if (direct) {
    const keywordOffset = direct[0].search(/\bTRUNCATE\b/iu)
    findings.push(
      truncateViolation(source, pathName, statement.offset + (direct.index ?? 0) + keywordOffset)
    )
  }

  const proceduralStatement =
    /^\s*(?:DO\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b)/iu.test(executableStatement)
  if (!proceduralStatement) return findings

  const atomic = executableStatement.match(/\bBEGIN\s+ATOMIC\b\s*(TRUNCATE)\b/iu)
  if (atomic) {
    const keywordOffset = atomic[0].search(/\bTRUNCATE\b/iu)
    findings.push(
      truncateViolation(source, pathName, statement.offset + (atomic.index ?? 0) + keywordOffset)
    )
  }

  for (const body of findProceduralBodies(statement, executableStatement)) {
    if (body.escapePrefixLength > 0) {
      findings.push(
        encodedProceduralSqlReviewViolation(
          source,
          pathName,
          statement.offset + body.openingOffset - body.escapePrefixLength
        )
      )
      continue
    }
    findings.push(...findProceduralViolations(source, pathName, statement, body, depth))
  }
  return findings
}

function findNotNullViolations(source, pathName, statement) {
  const findings = []
  const clauses = splitTopLevel(statement.text, ',').map((clause) => ({
    ...clause,
    searchable: maskStringLiteralContents(clause.text),
  }))
  const defaultedColumns = new Set()
  const alterDefaultPattern = new RegExp(
    String.raw`\bALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+SET\s+DEFAULT\b`,
    'iu'
  )

  for (const clause of clauses) {
    const match = clause.searchable.match(alterDefaultPattern)
    if (match) {
      const defaultExpression = clause.searchable.slice((match.index ?? 0) + match[0].length)
      if (!/^\s*(?:\(\s*)*NULL\b/iu.test(defaultExpression)) {
        defaultedColumns.add(normalizeIdentifier(match[1]))
      }
    }
  }

  const alterNotNullPattern = new RegExp(
    String.raw`\bALTER\s+(?:COLUMN\s+)?(${IDENTIFIER})\s+SET\s+NOT\s+NULL\b`,
    'iu'
  )
  const addColumnPattern = new RegExp(
    String.raw`\bADD\s+(COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})\b`,
    'iu'
  )
  const nonColumnAdditions = new Set([
    'check',
    'constraint',
    'exclude',
    'foreign',
    'primary',
    'unique',
  ])

  for (const clause of clauses) {
    const alterNotNull = clause.searchable.match(alterNotNullPattern)
    if (alterNotNull && !defaultedColumns.has(normalizeIdentifier(alterNotNull[1]))) {
      findings.push(
        violation(
          source,
          pathName,
          statement.offset + clause.offset + (alterNotNull.index ?? 0),
          'not-null-without-default',
          `ALTER COLUMN ${alterNotNull[1]} SET NOT NULL requires a DEFAULT for the same column`
        )
      )
    }

    const addColumn = clause.searchable.match(addColumnPattern)
    if (!addColumn) continue

    const explicitColumnKeyword = Boolean(addColumn[1])
    const column = normalizeIdentifier(addColumn[2])
    const plainColumn = column.startsWith('plain:') ? column.slice('plain:'.length) : ''
    if (!explicitColumnKeyword && nonColumnAdditions.has(plainColumn)) continue

    const remainderOffset = (addColumn.index ?? 0) + addColumn[0].length
    const remainder = clause.searchable.slice(remainderOffset)
    const notNullIndex = firstNotNullIndex(remainder)
    const defaultMatch = remainder.match(/\bDEFAULT\b/iu)
    const hasNonNullDefault =
      defaultMatch &&
      !/^\s*(?:\(\s*)*NULL\b/iu.test(
        remainder.slice((defaultMatch.index ?? 0) + defaultMatch[0].length)
      )
    if (notNullIndex >= 0 && !hasNonNullDefault) {
      findings.push(
        violation(
          source,
          pathName,
          statement.offset + clause.offset + remainderOffset + notNullIndex,
          'not-null-without-default',
          `ADD COLUMN ${addColumn[2]} NOT NULL requires a DEFAULT in the same clause`
        )
      )
    }
  }

  return findings
}

export function analyzeMigrationSql(source, pathName = '<migration>', depth = 0) {
  const searchableSource = maskSqlComments(source)
  const statements = splitTopLevel(searchableSource, ';')
  const findings = []

  for (const statement of statements) {
    const dropRule = {
      rule: 'drop',
      message: 'all DROP operations require explicit manual review',
      pattern: /\bDROP\b/giu,
    }
    findings.push(
      ...findPatternViolations({
        source,
        searchable: statement.text,
        path: pathName,
        statement,
        rule: dropRule,
      })
    )

    findings.push(...findTruncateViolations(source, pathName, statement, depth))

    if (!/\bALTER\s+TABLE\b/iu.test(statement.text)) continue

    for (const rule of DANGEROUS_ALTER_PATTERNS) {
      findings.push(
        ...findPatternViolations({
          source,
          searchable: statement.text,
          path: pathName,
          statement,
          rule,
        })
      )
    }
    findings.push(...findNotNullViolations(source, pathName, statement))
  }

  const uniqueFindings = [
    ...new Map(
      findings.map((finding) => [`${finding.path}:${finding.line}:${finding.rule}`, finding])
    ).values(),
  ]
  return uniqueFindings.sort(
    (left, right) => left.line - right.line || left.rule.localeCompare(right.rule)
  )
}

/**
 * Reviewed exceptions: a finding a person reviewed and accepted for one exact
 * migration file. An entry names the file, the sha256 of its exact bytes, one
 * reviewable rule and how many findings of that rule the file has. It waives
 * those findings only when all three match; any edit of the file, one more
 * finding, or another rule fails as before. Malformed entries are an
 * operational error (exit 2), not an empty list.
 */
export function parseReviewedExceptions(text, label = REVIEWED_EXCEPTIONS_PATH) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array`)
  const seen = new Set()
  return value.map((entry, index) => {
    const where = `${label}[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${where} must be an object`)
    }
    const keys = Object.keys(entry).sort()
    if (
      keys.length !== REVIEWED_EXCEPTION_KEYS.length ||
      keys.some((key, keyIndex) => key !== REVIEWED_EXCEPTION_KEYS[keyIndex])
    ) {
      throw new Error(`${where} must have exactly: ${REVIEWED_EXCEPTION_KEYS.join(', ')}`)
    }
    const { count, path: entryPath, review, rule, sha256 } = entry
    if (
      typeof entryPath !== 'string' ||
      !entryPath.startsWith(MIGRATIONS_PREFIX) ||
      !/^supabase\/migrations\/[0-9]{14}_[a-z0-9_]+\.sql$/u.test(entryPath)
    ) {
      throw new Error(`${where}.path must be one modern migration file`)
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) {
      throw new Error(`${where}.sha256 must be 64 lowercase hex digits`)
    }
    if (typeof rule !== 'string' || !REVIEWABLE_RULES.has(rule)) {
      throw new Error(`${where}.rule must be one of: ${[...REVIEWABLE_RULES].join(', ')}`)
    }
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new Error(`${where}.count must be an integer from 1 to 100`)
    }
    if (typeof review !== 'string' || review.trim().length < 20 || review.length > 1000) {
      throw new Error(`${where}.review must say what was reviewed (20 to 1000 characters)`)
    }
    const key = `${entryPath}\u0000${rule}`
    if (seen.has(key)) throw new Error(`${where} duplicates ${entryPath} ${rule}`)
    seen.add(key)
    return Object.freeze({ count, path: entryPath, review, rule, sha256 })
  })
}

function readReviewedExceptionsFromFile(root = ROOT) {
  const filePath = path.join(root, REVIEWED_EXCEPTIONS_PATH)
  if (!existsSync(filePath)) return []
  return parseReviewedExceptions(readFileSync(filePath, 'utf8'))
}

function readReviewedExceptionsAt(commit, root = ROOT) {
  let tree
  try {
    tree = gitBuffer(['ls-tree', '--full-tree', commit, '--', REVIEWED_EXCEPTIONS_PATH], root)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot read ${REVIEWED_EXCEPTIONS_PATH} at ${commit}: ${detail}`)
  }
  if (tree.length === 0) return []
  const blob = gitBuffer(['show', `${commit}:${REVIEWED_EXCEPTIONS_PATH}`], root)
  let text
  try {
    text = utf8Decoder.decode(blob)
  } catch {
    throw new Error(`${REVIEWED_EXCEPTIONS_PATH} at ${commit} is not valid UTF-8`)
  }
  return parseReviewedExceptions(text, `${REVIEWED_EXCEPTIONS_PATH}@${commit.slice(0, 12)}`)
}

// Hash the file's exact bytes: decoding may drop a byte-order mark, and the
// reviewed sha256 names the committed file, not its decoded text.
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Removes the findings a matching reviewed exception covers. Returns the
 * remaining findings; every waiver used is pushed onto `applied`.
 */
export function applyReviewedExceptions(findings, bytes, relativePath, exceptions, applied = []) {
  const entries = exceptions.filter((entry) => entry.path === relativePath)
  if (entries.length === 0) return findings
  if (!Buffer.isBuffer(bytes)) throw new TypeError('reviewed exceptions need the file bytes')
  const digest = sha256Hex(bytes)
  let remaining = findings
  const extra = []
  for (const entry of entries) {
    const covered = remaining.filter((finding) => finding.rule === entry.rule)
    if (entry.sha256 !== digest) {
      extra.push({
        path: relativePath,
        line: 1,
        rule: 'reviewed-exception-mismatch',
        message: `reviewed exception for ${entry.rule} names sha256 ${entry.sha256}, but the file is ${digest}`,
        snippet: '',
      })
      continue
    }
    if (covered.length !== entry.count) {
      extra.push({
        path: relativePath,
        line: 1,
        rule: 'reviewed-exception-mismatch',
        message: `reviewed exception for ${entry.rule} expects ${entry.count} finding(s), the file has ${covered.length}`,
        snippet: '',
      })
      continue
    }
    remaining = remaining.filter((finding) => finding.rule !== entry.rule)
    applied.push(entry)
  }
  return [...remaining, ...extra]
}

function repositoryPath(rawPath, root = ROOT) {
  const absolutePath = path.resolve(root, rawPath)
  const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, '/')
  if (relativePath.startsWith('../') || path.isAbsolute(relativePath)) {
    throw new Error(`migration path escapes repository root: ${rawPath}`)
  }
  if (!relativePath.endsWith('.sql')) throw new Error(`migration path is not SQL: ${rawPath}`)
  return { absolutePath, relativePath }
}

export function scanMigrationFiles(paths, root = ROOT, exceptions = [], applied = []) {
  const findings = []
  for (const rawPath of paths) {
    const { absolutePath, relativePath } = repositoryPath(rawPath, root)
    const stat = lstatSync(absolutePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`migration path must be a regular file: ${relativePath}`)
    }
    const bytes = readFileSync(absolutePath)
    const source = bytes.toString('utf8')
    findings.push(
      ...applyReviewedExceptions(
        analyzeMigrationSql(source, relativePath),
        bytes,
        relativePath,
        exceptions,
        applied
      )
    )
  }
  return findings
}

function gitBuffer(args, root = ROOT) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    env: {
      ...process.env,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function committedMigrationSource(rawPath, commit, root = ROOT) {
  const { relativePath } = repositoryPath(rawPath, root)
  if (!relativePath.startsWith(MIGRATIONS_PREFIX)) {
    throw new Error(`committed migration path is outside ${MIGRATIONS_PREFIX}: ${relativePath}`)
  }

  const tree = gitBuffer(['ls-tree', '-z', '--full-tree', commit, '--', relativePath], root)
  const recordEnd = tree.indexOf(0)
  if (recordEnd <= 0 || recordEnd !== tree.length - 1) {
    throw new Error(`committed migration tree entry is missing or malformed: ${relativePath}`)
  }
  const record = tree.subarray(0, recordEnd)
  const separator = record.indexOf(9)
  if (separator <= 0 || separator === record.length - 1) {
    throw new Error(`committed migration tree entry is malformed: ${relativePath}`)
  }

  const metadata = record.subarray(0, separator).toString('ascii')
  const match = /^(100644|100755) blob ([a-f0-9]+)$/u.exec(metadata)
  const treePath = record.subarray(separator + 1)
  if (
    !match ||
    match[2].length !== commit.length ||
    !treePath.equals(Buffer.from(relativePath, 'utf8'))
  ) {
    throw new Error(`committed migration must be one regular Git blob: ${relativePath}`)
  }

  const blob = gitBuffer(['cat-file', 'blob', match[2]], root)
  try {
    return { bytes: blob, relativePath, source: utf8Decoder.decode(blob) }
  } catch {
    throw new Error(`committed migration is not valid UTF-8: ${relativePath}`)
  }
}

export function scanMigrationBlobs(paths, commit, root = ROOT, exceptions = [], applied = []) {
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new Error('committed migration scan requires an exact commit id')
  }
  const findings = []
  for (const rawPath of paths) {
    const { bytes, relativePath, source } = committedMigrationSource(rawPath, commit, root)
    findings.push(
      ...applyReviewedExceptions(
        analyzeMigrationSql(source, relativePath),
        bytes,
        relativePath,
        exceptions,
        applied
      )
    )
  }
  return findings
}

function resolveBaseCommit(baseRef, root = ROOT) {
  if (!baseRef?.trim()) throw new Error('MIGRATION_SAFETY_BASE_REF is required')
  try {
    const commit = gitBuffer(
      ['rev-parse', '--verify', '--end-of-options', `${baseRef.trim()}^{commit}`],
      root
    )
      .toString('utf8')
      .trim()
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
      throw new Error(`git returned an invalid commit id: ${commit}`)
    }
    return commit
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot resolve migration safety base ref ${baseRef}: ${detail}`)
  }
}

export function parseChangedMigrationOutput(output) {
  const tokens = Buffer.from(output).toString('utf8').split('\0')
  if (tokens.at(-1) === '') tokens.pop()

  const paths = []
  const historyViolations = []
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++]
    const kind = status[0]
    if (!kind || !'ACDMRT'.includes(kind)) {
      throw new Error(`unsupported git migration change status: ${status || '<empty>'}`)
    }

    const firstPath = tokens[index++]
    if (!firstPath) throw new Error(`missing path for git migration change status ${status}`)
    const secondPath = kind === 'R' || kind === 'C' ? tokens[index++] : null
    if ((kind === 'R' || kind === 'C') && !secondPath) {
      throw new Error(`missing destination path for git migration change status ${status}`)
    }
    const currentPath = secondPath ?? firstPath
    const previousWasMigration =
      firstPath.startsWith(MIGRATIONS_PREFIX) && firstPath.endsWith('.sql')
    const currentIsMigration =
      currentPath.startsWith(MIGRATIONS_PREFIX) && currentPath.endsWith('.sql')

    if (kind === 'D' && previousWasMigration) {
      historyViolations.push({
        path: firstPath,
        line: 1,
        rule: 'migration-file-deleted',
        message: 'committed migration files are immutable and must not be deleted',
        snippet: '',
      })
    } else if ((kind === 'M' || kind === 'T') && previousWasMigration) {
      historyViolations.push({
        path: firstPath,
        line: 1,
        rule: 'migration-file-modified',
        message:
          'committed migration files are immutable and must not be modified in place; add a forward migration instead',
        snippet: '',
      })
      if (kind === 'M' && currentIsMigration) paths.push(currentPath)
    } else if (kind === 'R' && (previousWasMigration || currentIsMigration)) {
      historyViolations.push({
        path: currentPath,
        line: 1,
        rule: 'migration-file-renamed',
        message: `migration files must not be renamed or moved (${firstPath})`,
        snippet: '',
      })
      if (currentIsMigration) paths.push(currentPath)
    } else if (currentIsMigration) {
      paths.push(currentPath)
    }
  }

  return { paths: [...new Set(paths)], historyViolations }
}

export function changedMigrationFiles(baseRef, root = ROOT) {
  const baseCommit = resolveBaseCommit(baseRef, root)
  const headCommit = resolveBaseCommit('HEAD', root)
  let output
  try {
    output = gitBuffer(
      [
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        baseCommit,
        headCommit,
        '--',
        'supabase/migrations/',
      ],
      root
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot enumerate changed migrations from ${baseCommit}: ${detail}`)
  }

  return { baseCommit, headCommit, ...parseChangedMigrationOutput(output) }
}

export function run({ args = process.argv.slice(2), env = process.env, root = ROOT } = {}) {
  let paths = args
  let historyViolations = []
  let context = 'explicit file list'
  let sqlFindings
  const applied = []

  if (args.length === 0) {
    const changed = changedMigrationFiles(env.MIGRATION_SAFETY_BASE_REF, root)
    paths = changed.paths
    historyViolations = changed.historyViolations
    const exceptions = readReviewedExceptionsAt(changed.headCommit, root)
    // A reviewed exception may be added only together with the migration it
    // covers: an entry new in this diff must name a migration this diff adds.
    // Every migration already committed (and so every applied one) is out of
    // reach of a later waiver.
    const baseExceptions = readReviewedExceptionsAt(changed.baseCommit, root)
    const baseKeys = new Set(baseExceptions.map((entry) => JSON.stringify(entry)))
    const touched = new Set(historyViolations.map((violation) => violation.path))
    const added = new Set(paths.filter((migrationPath) => !touched.has(migrationPath)))
    for (const entry of exceptions) {
      if (baseKeys.has(JSON.stringify(entry)) || added.has(entry.path)) continue
      historyViolations.push({
        path: entry.path,
        line: 1,
        rule: 'reviewed-exception-retroactive',
        message: `a new reviewed exception must be added with its migration; ${entry.path} is not added in this diff`,
        snippet: '',
      })
    }
    sqlFindings = scanMigrationBlobs(paths, changed.headCommit, root, exceptions, applied)
    context = `base ${changed.baseCommit} to HEAD ${changed.headCommit}`
  } else {
    sqlFindings = scanMigrationFiles(paths, root, readReviewedExceptionsFromFile(root), applied)
  }

  for (const entry of applied) {
    console.log(
      `Reviewed exception applied: ${entry.path} rule=${entry.rule} count=${entry.count} sha256=${entry.sha256} review="${entry.review}"`
    )
  }

  const findings = [...historyViolations, ...sqlFindings]
  if (findings.length > 0) {
    console.error('Migration SQL safety check failed:')
    for (const finding of findings) {
      console.error(
        `- ${finding.path}:${finding.line} [${finding.rule}] ${finding.message}` +
          (finding.snippet ? `\n  ${finding.snippet}` : '')
      )
    }
    return 1
  }

  console.log(`Migration SQL safety check passed (${paths.length} files; ${context}).`)
  return 0
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  try {
    process.exitCode = run()
  } catch (error) {
    console.error(
      `Migration SQL safety checker error: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 2
  }
}
