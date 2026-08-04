#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function stripSqlComments(source) {
  let output = ''
  let state = 'normal'
  let blockDepth = 0

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
      if (current === "'" && next === "'") {
        output += next
        index += 1
      } else if (current === "'") {
        state = 'normal'
      }
      continue
    }

    if (state === 'double-quote') {
      output += current
      if (current === '"' && next === '"') {
        output += next
        index += 1
      } else if (current === '"') {
        state = 'normal'
      }
      continue
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

  return output
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function excerpt(value) {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact
}

export function findDangerousDdl(source) {
  const sql = stripSqlComments(source)
  const findings = []
  const dropPattern = /\bDROP\s+(TABLE|COLUMN)\b/giu

  for (const match of sql.matchAll(dropPattern)) {
    findings.push({
      kind: `DROP ${match[1].toUpperCase()}`,
      line: lineNumberAt(sql, match.index),
      excerpt: excerpt(sql.slice(match.index, sql.indexOf(';', match.index) + 1 || undefined)),
    })
  }

  const alterStatementPattern = /\bALTER\s+TABLE\b(?:(?!;)[\s\S])*(?:;|$)/giu
  for (const match of sql.matchAll(alterStatementPattern)) {
    if (!/\bALTER\s+COLUMN\b[\s\S]*\bSET\s+NOT\s+NULL\b/iu.test(match[0])) continue
    findings.push({
      kind: 'ALTER COLUMN SET NOT NULL',
      line: lineNumberAt(sql, match.index),
      excerpt: excerpt(match[0]),
    })
  }

  return findings
}

export function changedProductionMigrations(baseRevision, headRevision = 'HEAD') {
  const range = `${baseRevision}...${headRevision}`
  const changed = execFileSync(
    'git',
    ['diff', '--diff-filter=AM', '--name-only', '-z', range, '--', 'supabase/migrations'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )

  return changed
    .split('\0')
    .filter(Boolean)
    .filter((file) => /^supabase\/migrations\/[^/]+\.sql$/u.test(file))
}

export function main(argv = process.argv.slice(2)) {
  const [baseRevision, headRevision = 'HEAD'] = argv
  if (!baseRevision) {
    throw new Error('usage: migration-dangerous-ddl-check.mjs <base-revision> [head-revision]')
  }

  const migrations = changedProductionMigrations(baseRevision, headRevision)
  if (migrations.length === 0) {
    console.log('No production migration changes to lint')
    return 0
  }

  const findings = migrations.flatMap((file) =>
    findDangerousDdl(readFileSync(file, 'utf8')).map((finding) => ({ file, ...finding }))
  )

  if (findings.length === 0) {
    console.log(`Migration lint passed — scanned ${migrations.length} production migration(s)`)
    return 0
  }

  console.error('Dangerous migration patterns detected (review manually before merging):')
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.kind}: ${finding.excerpt}`)
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
