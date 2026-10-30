#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const ZERO_SHA = '0'.repeat(40)
const PRODUCTION_MIGRATION_PATTERN = /^supabase\/migrations\/[^/]+\.sql$/u

function git(args, options = {}) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function requireSha(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new Error(label + ' must be a full lowercase Git SHA')
  }
  return value
}

function resolveCommit(revision) {
  const resolved = git(['rev-parse', '--verify', revision + '^{commit}'], {
    encoding: 'utf8',
  }).trim()
  return requireSha(resolved, 'resolved revision ' + revision)
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function dollarQuoteDelimiterAt(source, index) {
  const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)
  return match?.[0] ?? null
}

function stripSqlComments(source, { nestedDollarBody = false } = {}) {
  let output = ''
  let state = 'normal'
  let blockDepth = 0
  let escapeString = false

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]
    const next = source[index + 1]

    if (state === 'line-comment') {
      if (current === '\n') {
        output += '\n'
        state = 'normal'
      } else {
        output += ' '
      }
      continue
    }

    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockDepth += 1
        output += '  '
        index += 1
      } else if (current === '*' && next === '/') {
        blockDepth -= 1
        output += '  '
        index += 1
        if (blockDepth === 0) state = 'normal'
      } else {
        output += current === '\n' ? '\n' : ' '
      }
      continue
    }

    if (state === 'single-quote') {
      output += current
      if (escapeString && current === '\\' && next !== undefined) {
        output += next
        index += 1
      } else if (current === "'" && next === "'") {
        output += next
        index += 1
      } else if (current === "'") {
        state = 'normal'
        escapeString = false
      }
      continue
    }

    if (state === 'double-quote') {
      output += current
      if (escapeString && current === '\\' && next !== undefined) {
        output += next
        index += 1
      } else if (current === '"' && next === '"') {
        output += next
        index += 1
      } else if (current === '"') {
        state = 'normal'
        escapeString = false
      }
      continue
    }

    const previous = source[index - 1]
    const hasTokenBoundary = previous === undefined || !/[A-Za-z0-9_$]/u.test(previous)

    if (hasTokenBoundary && (current === 'E' || current === 'e') && next === "'") {
      output += current + next
      state = 'single-quote'
      escapeString = true
      index += 1
      continue
    }

    if (
      hasTokenBoundary &&
      (current === 'U' || current === 'u') &&
      next === '&' &&
      (source[index + 2] === "'" || source[index + 2] === '"')
    ) {
      const quote = source[index + 2]
      output += current + '&' + quote
      state = quote === "'" ? 'single-quote' : 'double-quote'
      escapeString = true
      index += 2
      continue
    }

    if (current === '$') {
      const delimiter = dollarQuoteDelimiterAt(source, index)
      if (delimiter) {
        const bodyStart = index + delimiter.length
        const bodyEnd = source.indexOf(delimiter, bodyStart)
        if (bodyEnd === -1) {
          throw new Error(
            'unterminated dollar-quoted string at line ' + lineNumberAt(source, index)
          )
        }

        const body = source.slice(bodyStart, bodyEnd)
        let scannedBody
        try {
          scannedBody = stripSqlComments(body, { nestedDollarBody: true })
        } catch (error) {
          if (nestedDollarBody) throw error
          // Function bodies are executable SQL/PLpgSQL, while dollar-quoted
          // data may contain arbitrary quote characters. Retaining an
          // unparseable body verbatim is conservative: dangerous keywords
          // remain visible to the scanner.
          scannedBody = body
        }
        output += delimiter + scannedBody + delimiter
        index = bodyEnd + delimiter.length - 1
        continue
      }
    }

    if (current === '-' && next === '-') {
      state = 'line-comment'
      output += '  '
      index += 1
    } else if (current === '/' && next === '*') {
      state = 'block-comment'
      blockDepth = 1
      output += '  '
      index += 1
    } else {
      output += current
      if (current === "'") state = 'single-quote'
      if (current === '"') state = 'double-quote'
    }
  }

  if (state === 'block-comment') {
    throw new Error('unterminated SQL block comment')
  }
  if (state === 'single-quote' || state === 'double-quote') {
    throw new Error('unterminated SQL quoted value')
  }

  return output
}

function excerpt(value) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? compact.slice(0, 177) + '...' : compact
}

export function findDangerousDdl(source) {
  const sql = stripSqlComments(source)
  const findings = []
  const dropPattern = /\bDROP\s+(TABLE|COLUMN)\b/giu

  for (const match of sql.matchAll(dropPattern)) {
    findings.push({
      kind: 'DROP ' + match[1].toUpperCase(),
      line: lineNumberAt(sql, match.index),
      excerpt: excerpt(sql.slice(match.index, sql.indexOf(';', match.index) + 1 || undefined)),
    })
  }

  const setNotNullPattern =
    /\bALTER(?:\s+COLUMN)?\s+(?:(?:U&)?"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s+SET\s+NOT\s+NULL\b/giu

  for (const match of sql.matchAll(setNotNullPattern)) {
    findings.push({
      kind: 'ALTER COLUMN SET NOT NULL',
      line: lineNumberAt(sql, match.index),
      excerpt: excerpt(match[0]),
    })
  }

  return findings
}

export function comparisonFromEvent(event, checkoutRevision = 'HEAD') {
  const checkoutSha = resolveCommit(checkoutRevision)

  if (event?.pull_request) {
    const baseSha = requireSha(event.pull_request?.base?.sha, 'pull request base SHA')
    resolveCommit(baseSha)
    return {
      kind: 'range',
      range: baseSha + '...' + checkoutSha,
      headSha: checkoutSha,
    }
  }

  if (Object.hasOwn(event ?? {}, 'before') || Object.hasOwn(event ?? {}, 'after')) {
    const afterSha = requireSha(event.after, 'push after SHA')
    resolveCommit(afterSha)
    if (afterSha !== checkoutSha) {
      throw new Error('push after SHA ' + afterSha + ' does not match checkout HEAD ' + checkoutSha)
    }

    if (event.before === ZERO_SHA) {
      return { kind: 'all', headSha: afterSha }
    }

    const beforeSha = requireSha(event.before, 'push before SHA')
    resolveCommit(beforeSha)
    return {
      kind: 'range',
      range: beforeSha + '..' + afterSha,
      headSha: afterSha,
    }
  }

  throw new Error('unsupported GitHub event for migration lint')
}

export function changedProductionMigrations(comparison) {
  let changed
  if (comparison.kind === 'all') {
    changed = git(
      ['ls-tree', '-r', '--name-only', '-z', comparison.headSha, '--', 'supabase/migrations'],
      { encoding: 'utf8' }
    )
  } else if (comparison.kind === 'range') {
    changed = git(
      [
        'diff',
        '--find-renames',
        '--diff-filter=ACMRT',
        '--name-only',
        '-z',
        comparison.range,
        '--',
        'supabase/migrations',
      ],
      { encoding: 'utf8' }
    )
  } else {
    throw new Error('unsupported migration comparison kind: ' + comparison.kind)
  }

  return [...new Set(changed.split('\0').filter(Boolean))].filter((file) =>
    PRODUCTION_MIGRATION_PATTERN.test(file)
  )
}

function readMigrationBlob(headSha, file) {
  const entry = git(['ls-tree', '-z', headSha, '--', file], { encoding: 'utf8' })
  const match = entry.match(/^([0-9]{6}) (blob|tree|commit) ([0-9a-f]+)\t([^\0]+)\0$/u)

  if (!match || match[4] !== file) {
    throw new Error('migration path is missing from head tree: ' + file)
  }
  if (!['100644', '100755'].includes(match[1]) || match[2] !== 'blob') {
    throw new Error('production migration must be a regular Git blob: ' + file)
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(git(['cat-file', 'blob', match[3]]))
}

export function main(argv = process.argv.slice(2)) {
  const [eventFlag, eventPath, checkoutRevision = 'HEAD'] = argv
  if (eventFlag !== '--event' || !eventPath || argv.length > 3) {
    throw new Error(
      'usage: migration-dangerous-ddl-check.mjs --event <github-event-path> [checkout-revision]'
    )
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const comparison = comparisonFromEvent(event, checkoutRevision)
  const migrations = changedProductionMigrations(comparison)
  if (migrations.length === 0) {
    console.log('No production migration changes to lint')
    return 0
  }

  const findings = migrations.flatMap((file) =>
    findDangerousDdl(readMigrationBlob(comparison.headSha, file)).map((finding) => ({
      file,
      ...finding,
    }))
  )

  if (findings.length === 0) {
    console.log('Migration lint passed — scanned ' + migrations.length + ' production migration(s)')
    return 0
  }

  console.error('Dangerous migration patterns detected (review manually before merging):')
  for (const finding of findings) {
    console.error(finding.file + ':' + finding.line + ': ' + finding.kind + ': ' + finding.excerpt)
  }
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
