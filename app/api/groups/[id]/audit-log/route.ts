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
const CursorSchema = z
  .object({
    created_at: z.string().datetime({ offset: true }),
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
    created_at: z.string().datetime({ offset: true }),
  })
  .strict()
const ViewerProfileSchema = z
  .object({
    id: UuidSchema,
    deleted_at: z.string().datetime({ offset: true }).nullable(),
    banned_at: z.string().datetime({ offset: true }).nullable(),
    is_banned: z.boolean().nullable(),
    ban_expires_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
const GroupSchema = z
  .object({
    id: UuidSchema,
    dissolved_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
const MembershipSchema = z.object({ role: z.enum(['owner', 'admin', 'member']) }).strict()

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

    // Re-check the application account at this service-role boundary instead
    // of relying only on authentication middleware state. This mirrors group
    // mutation semantics, including active temporary bans.
    const { data: rawProfile, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, deleted_at, banned_at, is_banned, ban_expires_at')
      .eq('id', actorId.data)
      .maybeSingle()

    if (profileError) {
      log.error('Group audit-log viewer lookup failed', {
        actorId: actorId.data,
        code: profileError.code,
      })
      return json({ error: 'Failed to load group audit log' }, 500)
    }

    if (!rawProfile) {
      return json({ error: 'Permission denied' }, 403)
    }
    const profile = ViewerProfileSchema.safeParse(rawProfile)
    if (!profile.success || profile.data.id !== actorId.data) {
      log.error('Group audit-log viewer response was invalid', { actorId: actorId.data })
      return json({ error: 'Failed to load group audit log' }, 500)
    }
    const activelyBanned =
      profile.data.is_banned === true &&
      (profile.data.ban_expires_at === null || Date.parse(profile.data.ban_expires_at) > Date.now())
    if (profile.data.deleted_at || profile.data.banned_at || activelyBanned) {
      return json({ error: 'Permission denied' }, 403)
    }

    const { data: rawGroup, error: groupError } = await supabase
      .from('groups')
      .select('id, dissolved_at')
      .eq('id', groupId)
      .maybeSingle()

    if (groupError) {
      log.error('Group audit-log group lookup failed', { groupId, code: groupError.code })
      return json({ error: 'Failed to load group audit log' }, 500)
    }
    if (!rawGroup) return json({ error: 'Group not found' }, 404)
    const group = GroupSchema.safeParse(rawGroup)
    if (!group.success || group.data.id !== groupId) {
      log.error('Group audit-log group response was invalid', { groupId })
      return json({ error: 'Failed to load group audit log' }, 500)
    }
    if (group.data.dissolved_at) {
      return json({ error: 'This group has been dissolved' }, 409)
    }

    const { data: rawMembership, error: membershipError } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', actorId.data)
      .maybeSingle()

    if (membershipError) {
      log.error('Group audit-log membership lookup failed', {
        groupId,
        actorId: actorId.data,
        code: membershipError.code,
      })
      return json({ error: 'Failed to load group audit log' }, 500)
    }
    if (!rawMembership) {
      return json({ error: 'Permission denied' }, 403)
    }
    const membership = MembershipSchema.safeParse(rawMembership)
    if (!membership.success) {
      log.error('Group audit-log membership response was invalid', {
        groupId,
        actorId: actorId.data,
      })
      return json({ error: 'Failed to load group audit log' }, 500)
    }
    if (membership.data.role !== 'owner' && membership.data.role !== 'admin') {
      return json({ error: 'Permission denied' }, 403)
    }

    let query = supabase
      .from('group_audit_log')
      .select('id, action, actor_id, target_id, created_at')
      .eq('group_id', groupId)
      .not('created_at', 'is', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })

    if (input.cursor) {
      const { created_at: createdAt, id } = input.cursor
      query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`)
    }

    const { data, error } = await query.limit(input.limit + 1)
    if (error) {
      log.error('Group audit-log page query failed', { groupId, code: error.code })
      return json({ error: 'Failed to load group audit log' }, 500)
    }

    const parsedRows = z
      .array(AuditLogRowSchema)
      .max(input.limit + 1)
      .safeParse(data)
    if (!parsedRows.success) {
      log.error('Group audit-log page returned an invalid response', { groupId })
      return json({ error: 'Failed to load group audit log' }, 500)
    }

    const hasMore = parsedRows.data.length > input.limit
    const logs = parsedRows.data.slice(0, input.limit).map((row) => ({
      id: row.id,
      action: row.action,
      actor_id: row.actor_id,
      target_id: row.target_id,
      created_at: row.created_at,
    }))
    const last = logs.at(-1)
    const nextCursor =
      hasMore && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null

    return json({
      success: true,
      logs,
      pagination: {
        limit: input.limit,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    })
  },
  { name: 'group-audit-log', rateLimit: 'read' }
)
