import { Buffer } from 'node:buffer'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { createLogger } from '@/lib/utils/logger'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const log = createLogger('api:group-audit-log')
const DEFAULT_LIMIT = 50
const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const LimitSchema = z
  .string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
  .transform((value) => Number(value))
const EncodedCursorSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
const TimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1].length ?? 0) <= 6)
const CursorSchema = z
  .object({
    created_at: TimestampSchema,
    id: UuidSchema,
  })
  .strict()
const AuditLogRowSchema = z
  .object({
    id: UuidSchema,
    action: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_]*$/),
    actor_id: UuidSchema.nullable(),
    target_id: UuidSchema.nullable(),
    created_at: TimestampSchema,
  })
  .strict()
const AuditLogSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: UuidSchema,
    group_id: UuidSchema,
    logs: z.array(AuditLogRowSchema).max(100),
    has_more: z.boolean(),
  })
  .strict()
const AuditLogFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum([
      'INVALID',
      'ACTOR_UNAVAILABLE',
      'GROUP_NOT_FOUND',
      'GROUP_DISSOLVED',
      'PERMISSION_DENIED',
    ]),
  })
  .strict()
const AuditLogResultSchema = z.discriminatedUnion('success', [
  AuditLogSuccessSchema,
  AuditLogFailureSchema,
])

type AuditCursor = z.infer<typeof CursorSchema>

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS })
}

function readGroupId(url: URL): string | null {
  const pathParts = url.pathname.split('/')
  const groupsIndex = pathParts.indexOf('groups')
  const parsed = UuidSchema.safeParse(pathParts[groupsIndex + 1])
  return parsed.success ? parsed.data : null
}

function decodeCursor(value: string): AuditCursor | null {
  const encoded = EncodedCursorSchema.safeParse(value)
  if (!encoded.success) return null

  try {
    const decoded = Buffer.from(encoded.data, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded.data) return null
    const parsed = CursorSchema.safeParse(JSON.parse(decoded))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function readListInput(url: URL): { limit: number; cursor: AuditCursor | null } | null {
  const allowed = new Set(['limit', 'cursor'])
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null
  }

  const rawLimit = url.searchParams.get('limit')
  const parsedLimit = rawLimit === null ? null : LimitSchema.safeParse(rawLimit)
  if (parsedLimit !== null && !parsedLimit.success) return null

  const rawCursor = url.searchParams.get('cursor')
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor)
  if (rawCursor !== null && cursor === null) return null

  return { limit: parsedLimit?.data ?? DEFAULT_LIMIT, cursor }
}

function timestampParts(value: string): readonly [milliseconds: number, submillisecond: number] {
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? ''
  const nanoseconds = Number(`${fraction}000000000`.slice(0, 9))
  return [Date.parse(value), nanoseconds % 1_000_000]
}

function compareTimestamp(left: string, right: string): number {
  const [leftMilliseconds, leftSubmillisecond] = timestampParts(left)
  const [rightMilliseconds, rightSubmillisecond] = timestampParts(right)
  if (leftMilliseconds !== rightMilliseconds) return leftMilliseconds - rightMilliseconds
  return leftSubmillisecond - rightSubmillisecond
}

function isBeforeCursor(row: z.infer<typeof AuditLogRowSchema>, cursor: AuditCursor): boolean {
  const timestampOrder = compareTimestamp(row.created_at, cursor.created_at)
  return timestampOrder < 0 || (timestampOrder === 0 && row.id < cursor.id)
}

function isStrictlyDescending(
  previous: z.infer<typeof AuditLogRowSchema>,
  current: z.infer<typeof AuditLogRowSchema>
): boolean {
  const timestampOrder = compareTimestamp(previous.created_at, current.created_at)
  return timestampOrder > 0 || (timestampOrder === 0 && previous.id > current.id)
}

function matchesRequestedPage(
  result: z.infer<typeof AuditLogSuccessSchema>,
  actorId: string,
  groupId: string,
  input: { limit: number; cursor: AuditCursor | null }
): boolean {
  if (
    result.actor_id !== actorId ||
    result.group_id !== groupId ||
    result.logs.length > input.limit ||
    (result.has_more && result.logs.length !== input.limit)
  ) {
    return false
  }

  const ids = new Set<string>()
  for (let index = 0; index < result.logs.length; index += 1) {
    const row = result.logs[index]
    if (ids.has(row.id) || (input.cursor && !isBeforeCursor(row, input.cursor))) return false
    ids.add(row.id)
    if (index > 0 && !isStrictlyDescending(result.logs[index - 1], row)) return false
  }
  return true
}

function failureResponse(reason: z.infer<typeof AuditLogFailureSchema>['reason']) {
  switch (reason) {
    case 'INVALID':
      return json({ error: 'Invalid audit log request' }, 400)
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return json({ error: 'Permission denied' }, 403)
    case 'GROUP_NOT_FOUND':
      return json({ error: 'Group not found' }, 404)
    case 'GROUP_DISSOLVED':
      return json({ error: 'This group has been dissolved' }, 409)
  }
}

export const GET = withAuth(
  async ({ user, request, supabase }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return json({ error: 'Invalid audit log request' }, 400)
    }

    const groupId = readGroupId(url)
    const input = readListInput(url)
    if (!groupId || !input) {
      return json({ error: 'Invalid audit log request' }, 400)
    }

    const actorId = UuidSchema.safeParse(user.id)
    if (!actorId.success) return json({ error: 'Permission denied' }, 403)

    const { data, error } = await supabase.rpc('get_group_audit_log_page_atomic', {
      p_actor_id: actorId.data,
      p_group_id: groupId,
      p_before_created_at: input.cursor?.created_at ?? null,
      p_before_id: input.cursor?.id ?? null,
      p_limit: input.limit,
    })
    if (error) {
      log.error('Atomic group audit-log page query failed', {
        groupId,
        actorId: actorId.data,
        code: error.code,
      })
      return json({ error: 'Failed to load group audit log' }, 500)
    }

    const parsedResult = AuditLogResultSchema.safeParse(data)
    if (!parsedResult.success) {
      log.error('Atomic group audit-log page returned an invalid response', {
        groupId,
        actorId: actorId.data,
      })
      return json({ error: 'Failed to load group audit log' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return failureResponse(result.reason)
    if (!matchesRequestedPage(result, actorId.data, groupId, input)) {
      log.error('Atomic group audit-log page returned mismatched evidence', {
        groupId,
        actorId: actorId.data,
      })
      return json({ error: 'Failed to load group audit log' }, 500)
    }

    const last = result.logs.at(-1)
    const nextCursor =
      result.has_more && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null

    return json({
      success: true,
      logs: result.logs,
      pagination: {
        limit: input.limit,
        has_more: result.has_more,
        next_cursor: nextCursor,
      },
    })
  },
  { name: 'group-audit-log', rateLimit: 'read' }
)
