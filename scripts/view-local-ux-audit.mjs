#!/usr/bin/env node
// Viewer for logs/local-ux-audit.jsonl — the local dev backend audit trail written by
// lib/utils/local-ux-audit-log.ts. Read-only: never touches app code or the app itself.
//
// Usage:
//   node scripts/view-local-ux-audit.mjs                 # pretty-print everything so far
//   node scripts/view-local-ux-audit.mjs --follow         # live tail while you click around (Ctrl+C to stop)
//   node scripts/view-local-ux-audit.mjs --errors         # only 4xx/5xx responses, warnings, errors
//   node scripts/view-local-ux-audit.mjs --path=/api/posts# only entries whose path includes this string
//   node scripts/view-local-ux-audit.mjs --json           # raw JSON lines instead of formatted
//   node scripts/view-local-ux-audit.mjs --summary        # counts by type/status, no line-by-line detail
//   node scripts/view-local-ux-audit.mjs --clear           # truncate the log files and start fresh

import fs from 'node:fs'
import path from 'node:path'

const LOG_DIR = path.join(process.cwd(), 'logs')
const JSONL_FILE = path.join(LOG_DIR, 'local-ux-audit.jsonl')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

if (flag('clear')) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.writeFileSync(JSONL_FILE, '')
  fs.writeFileSync(path.join(LOG_DIR, 'local-ux-audit.log'), '')
  console.log('Cleared logs/local-ux-audit.jsonl and logs/local-ux-audit.log')
  process.exit(0)
}

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}

function statusColor(status) {
  if (status == null) return COLORS.gray
  if (status >= 500) return COLORS.red
  if (status >= 400) return COLORS.yellow
  if (status >= 300) return COLORS.cyan
  return COLORS.green
}

function typeColor(type) {
  switch (type) {
    case 'request_error':
      return COLORS.red
    case 'api':
      return COLORS.magenta
    case 'request':
      return COLORS.cyan
    case 'response':
      return COLORS.green
    case 'session_start':
      return COLORS.gray
    default:
      return COLORS.reset
  }
}

function isErrorish(entry) {
  if (entry.type === 'request_error') return true
  if (typeof entry.status === 'number' && entry.status >= 400) return true
  if (entry.level === 'error' || entry.level === 'warn') return true
  if (entry.error) return true
  return false
}

function formatEntry(entry) {
  const parts = []
  parts.push(COLORS.gray + entry.ts + COLORS.reset)
  parts.push(typeColor(entry.type) + entry.type.toUpperCase().padEnd(13) + COLORS.reset)

  if (entry.method && entry.path) {
    parts.push(`${entry.method} ${entry.path}`)
  } else if (entry.path) {
    parts.push(entry.path)
  }

  if (entry.status != null) {
    parts.push(statusColor(entry.status) + String(entry.status) + COLORS.reset)
  }
  if (entry.durationMs != null) {
    const slow = entry.durationMs >= 1000
    parts.push((slow ? COLORS.yellow : COLORS.gray) + `${entry.durationMs}ms` + COLORS.reset)
  }
  if (entry.logger) parts.push(`[${entry.logger}]`)
  if (entry.level) parts.push(`(${entry.level})`)
  if (entry.summary) parts.push(entry.summary)
  else if (entry.message) parts.push(entry.message)
  if (entry.userId) parts.push(`user=${entry.userId}`)
  if (entry.hasSession != null) parts.push(`session=${entry.hasSession}`)
  if (entry.error) parts.push(COLORS.red + `ERROR: ${entry.error}` + COLORS.reset)
  if (entry.requestId) parts.push(COLORS.gray + `rid=${entry.requestId}` + COLORS.reset)
  if (entry.correlationId) parts.push(COLORS.gray + `cid=${entry.correlationId}` + COLORS.reset)

  return parts.filter(Boolean).join('  ')
}

function readAllEntries() {
  if (!fs.existsSync(JSONL_FILE)) return []
  const raw = fs.readFileSync(JSONL_FILE, 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function matchesFilters(entry) {
  if (flag('errors') && !isErrorish(entry)) return false
  const pathFilter = value('path')
  if (pathFilter && !(entry.path || '').includes(pathFilter)) return false
  return true
}

function printSummary(entries) {
  const byType = {}
  const byStatus = {}
  let errorCount = 0
  for (const e of entries) {
    byType[e.type] = (byType[e.type] || 0) + 1
    if (e.status != null) byStatus[e.status] = (byStatus[e.status] || 0) + 1
    if (isErrorish(e)) errorCount++
  }
  console.log(`Total entries: ${entries.length}`)
  console.log(`Error-ish entries: ${errorCount}`)
  console.log('\nBy type:')
  for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(15)} ${c}`)
  }
  console.log('\nBy HTTP status:')
  for (const [s, c] of Object.entries(byStatus).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${s.padEnd(15)} ${c}`)
  }
}

function main() {
  if (!fs.existsSync(JSONL_FILE)) {
    console.log(`No log file yet at ${path.relative(process.cwd(), JSONL_FILE)}.`)
    console.log('Start `npm run dev` and use the app — entries will appear here.')
    if (flag('follow')) {
      console.log('Waiting for the file to be created...')
    } else {
      return
    }
  }

  const entries = readAllEntries().filter(matchesFilters)

  if (flag('summary')) {
    printSummary(entries)
    return
  }

  if (flag('json')) {
    for (const e of entries) console.log(JSON.stringify(e))
  } else {
    for (const e of entries) console.log(formatEntry(e))
  }

  if (flag('follow')) {
    console.log(COLORS.gray + '\n--- following logs/local-ux-audit.jsonl, Ctrl+C to stop ---\n' + COLORS.reset)
    let lastSize = fs.existsSync(JSONL_FILE) ? fs.statSync(JSONL_FILE).size : 0
    fs.watchFile(JSONL_FILE, { interval: 500 }, () => {
      if (!fs.existsSync(JSONL_FILE)) return
      const stat = fs.statSync(JSONL_FILE)
      if (stat.size < lastSize) lastSize = 0 // file was cleared
      if (stat.size === lastSize) return
      const stream = fs.createReadStream(JSONL_FILE, { start: lastSize, end: stat.size })
      let buf = ''
      stream.on('data', (chunk) => {
        buf += chunk
      })
      stream.on('end', () => {
        lastSize = stat.size
        for (const line of buf.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line)
            if (!matchesFilters(entry)) continue
            console.log(flag('json') ? JSON.stringify(entry) : formatEntry(entry))
          } catch {
            /* skip malformed line */
          }
        }
      })
    })
  }
}

main()
