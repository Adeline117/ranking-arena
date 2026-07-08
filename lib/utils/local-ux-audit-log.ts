/**
 * Local UX audit file logger — dev-only, server-side.
 *
 * Appends JSON lines to logs/local-ux-audit.jsonl (gitignored) while `npm run dev`
 * runs. No env vars or setup-script changes required.
 *
 * View later:
 *   cat logs/local-ux-audit.jsonl | jq .
 *   node scripts/view-local-ux-audit.mjs
 */

import fs from 'node:fs'
import path from 'node:path'

export type LocalUxAuditEventType =
  | 'session_start'
  | 'request'
  | 'response'
  | 'api'
  | 'log'
  | 'request_error'

export interface LocalUxAuditEntry {
  type: LocalUxAuditEventType
  summary?: string
  method?: string
  path?: string
  status?: number
  durationMs?: number
  requestId?: string
  correlationId?: string
  level?: string
  logger?: string
  message?: string
  userId?: string
  hasSession?: boolean
  error?: string
  data?: unknown
}

const LOG_DIR = path.join(process.cwd(), 'logs')
const JSONL_FILE = path.join(LOG_DIR, 'local-ux-audit.jsonl')
const TEXT_FILE = path.join(LOG_DIR, 'local-ux-audit.log')

function isEnabled(): boolean {
  return typeof window === 'undefined' && process.env.NODE_ENV !== 'production'
}

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true })
}

function formatHumanLine(entry: LocalUxAuditEntry & { ts: string }): string {
  const parts = [entry.ts, entry.type.toUpperCase()]
  if (entry.method && entry.path) parts.push(`${entry.method} ${entry.path}`)
  if (entry.status != null) parts.push(String(entry.status))
  if (entry.durationMs != null) parts.push(`${entry.durationMs}ms`)
  if (entry.level) parts.push(entry.level.toUpperCase())
  if (entry.summary) parts.push(entry.summary)
  else if (entry.message) parts.push(entry.message)
  if (entry.error) parts.push(`ERR=${entry.error}`)
  if (entry.requestId) parts.push(`rid=${entry.requestId}`)
  if (entry.correlationId) parts.push(`cid=${entry.correlationId}`)
  return parts.join(' | ') + '\n'
}

export function isLocalUxAuditEnabled(): boolean {
  return isEnabled()
}

export function getLocalUxAuditLogPath(): string {
  return JSONL_FILE
}

export function appendLocalUxAudit(entry: LocalUxAuditEntry): void {
  if (!isEnabled()) return

  try {
    ensureLogDir()
    const ts = new Date().toISOString()
    const record = { ts, ...entry }
    fs.appendFileSync(JSONL_FILE, `${JSON.stringify(record)}\n`)
    fs.appendFileSync(TEXT_FILE, formatHumanLine(record))
  } catch {
    // Never break local dev if disk is full or permissions fail.
  }
}

export function logLocalUxSessionStart(): void {
  appendLocalUxAudit({
    type: 'session_start',
    summary: 'dev server started — local UX audit logging active',
    data: {
      nodeEnv: process.env.NODE_ENV,
      appUrl: process.env.NEXT_PUBLIC_APP_URL,
    },
  })
}

export function logLocalUxRequest(input: {
  method: string
  path: string
  requestId?: string
  hasSession?: boolean
  query?: string
}): void {
  appendLocalUxAudit({
    type: 'request',
    summary: `${input.method} ${input.path}`,
    method: input.method,
    path: input.path,
    requestId: input.requestId,
    hasSession: input.hasSession,
    data: input.query ? { query: input.query } : undefined,
  })
}

export function logLocalUxResponse(input: {
  method: string
  path: string
  status: number
  requestId?: string
  durationMs?: number
  note?: string
}): void {
  appendLocalUxAudit({
    type: 'response',
    summary: `${input.method} ${input.path} → ${input.status}`,
    method: input.method,
    path: input.path,
    status: input.status,
    requestId: input.requestId,
    durationMs: input.durationMs,
    data: input.note ? { note: input.note } : undefined,
  })
}

export function logLocalUxApi(input: {
  name: string
  method: string
  path: string
  status: number
  durationMs: number
  correlationId?: string
  userId?: string
  error?: string
}): void {
  appendLocalUxAudit({
    type: 'api',
    summary: `${input.method} ${input.path} [${input.name}] → ${input.status} (${input.durationMs}ms)`,
    method: input.method,
    path: input.path,
    status: input.status,
    durationMs: input.durationMs,
    correlationId: input.correlationId,
    userId: input.userId,
    logger: input.name,
    error: input.error,
  })
}

export function logLocalUxLoggerMirror(input: {
  level: string
  message: string
  logger?: string
  correlationId?: string
  data?: unknown
}): void {
  appendLocalUxAudit({
    type: 'log',
    level: input.level,
    message: input.message,
    logger: input.logger,
    correlationId: input.correlationId,
    summary: input.message,
    data: input.data,
  })
}

export function logLocalUxRequestError(input: {
  path: string
  method: string
  message: string
  routePath?: string
  routeType?: string
}): void {
  appendLocalUxAudit({
    type: 'request_error',
    summary: `${input.method} ${input.path}: ${input.message}`,
    method: input.method,
    path: input.path,
    error: input.message,
    data: {
      routePath: input.routePath,
      routeType: input.routeType,
    },
  })
}
