import { Buffer } from 'node:buffer'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'
import {
  groupEditApplicationInputSchema,
  groupEditGroupIdSchema,
  submitGroupEditApplicationResultSchema,
  type GroupEditApplicationInput,
  type SubmitGroupEditApplicationResult,
} from '../../edit-applications/contracts'

const DEFAULT_LIST_LIMIT = 50
const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const ListLimitSchema = z
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
const ListCursorSchema = z
  .object({
    created_at: TimestampSchema,
    id: CanonicalUuidSchema,
  })
  .strict()
const JsonValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.object({}).passthrough(),
])
const ListedApplicationSchema = z
  .object({
    id: CanonicalUuidSchema,
    group_id: CanonicalUuidSchema,
    applicant_id: CanonicalUuidSchema,
    name: z.string().nullable(),
    name_en: z.string().nullable(),
    description: z.string().nullable(),
    description_en: z.string().nullable(),
    avatar_url: z.string().nullable(),
    rules_json: JsonValueSchema,
    rules: z.string().nullable(),
    role_names: JsonValueSchema,
    is_premium_only: z.boolean().nullable(),
    status: z.enum(['pending', 'approved', 'rejected']),
    reject_reason: z.string().nullable(),
    reviewed_at: TimestampSchema.nullable(),
    created_at: TimestampSchema,
  })
  .strict()
const ListSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: CanonicalUuidSchema,
    group_id: CanonicalUuidSchema,
    applications: z.array(ListedApplicationSchema).max(100),
    has_more: z.boolean(),
  })
  .strict()
const ListFailureSchema = z
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
const ListResultSchema = z.discriminatedUnion('success', [ListSuccessSchema, ListFailureSchema])

type ListCursor = z.infer<typeof ListCursorSchema>

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function decodeListCursor(value: string): ListCursor | null {
  const encoded = EncodedCursorSchema.safeParse(value)
  if (!encoded.success) return null
  try {
    const decoded = Buffer.from(encoded.data, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded.data) return null
    const parsed = ListCursorSchema.safeParse(JSON.parse(decoded))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function readListInput(url: URL): { limit: number; cursor: ListCursor | null } | null {
  for (const key of url.searchParams.keys()) {
    if (!['limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1) return null
  }
  const rawLimit = url.searchParams.get('limit')
  const parsedLimit = rawLimit === null ? null : ListLimitSchema.safeParse(rawLimit)
  if (parsedLimit !== null && !parsedLimit.success) return null
  const rawCursor = url.searchParams.get('cursor')
  const cursor = rawCursor === null ? null : decodeListCursor(rawCursor)
  if (rawCursor !== null && cursor === null) return null
  return { limit: parsedLimit?.data ?? DEFAULT_LIST_LIMIT, cursor }
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

function isBeforeCursor(application: z.infer<typeof ListedApplicationSchema>, cursor: ListCursor) {
  const timestampOrder = compareTimestamp(application.created_at, cursor.created_at)
  return timestampOrder < 0 || (timestampOrder === 0 && application.id < cursor.id)
}

function matchesListRequest(
  result: z.infer<typeof ListSuccessSchema>,
  actorId: string,
  groupId: string,
  input: { limit: number; cursor: ListCursor | null }
): boolean {
  if (
    result.actor_id !== actorId ||
    result.group_id !== groupId ||
    result.applications.length > input.limit ||
    (result.has_more && result.applications.length !== input.limit)
  ) {
    return false
  }

  const ids = new Set<string>()
  for (let index = 0; index < result.applications.length; index += 1) {
    const application = result.applications[index]
    if (
      application.group_id !== groupId ||
      ids.has(application.id) ||
      (input.cursor && !isBeforeCursor(application, input.cursor))
    ) {
      return false
    }
    ids.add(application.id)
    if (index > 0) {
      const previous = result.applications[index - 1]
      const timestampOrder = compareTimestamp(previous.created_at, application.created_at)
      if (timestampOrder < 0 || (timestampOrder === 0 && previous.id <= application.id)) {
        return false
      }
    }
  }
  return true
}

function listFailureResponse(reason: z.infer<typeof ListFailureSchema>['reason']) {
  switch (reason) {
    case 'INVALID':
      return privateJson({ error: 'Invalid edit application request' }, 400)
    case 'ACTOR_UNAVAILABLE':
    case 'PERMISSION_DENIED':
      return privateJson({ error: 'Permission denied' }, 403)
    case 'GROUP_NOT_FOUND':
      return privateJson({ error: 'Group not found' }, 404)
    case 'GROUP_DISSOLVED':
      return privateJson({ error: 'The group has been dissolved' }, 409)
  }
}

/** Extract group id from URL path */
function extractGroupId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('groups')
  return pathParts[idx + 1]
}

function submitFailureResponse(result: SubmitGroupEditApplicationResult): NextResponse {
  switch (result.status) {
    case 'invalid':
      return NextResponse.json({ error: 'Invalid edit application' }, { status: 400 })
    case 'account_inactive':
      return NextResponse.json({ error: 'Your account is not active' }, { status: 403 })
    case 'forbidden':
      return NextResponse.json(
        { error: 'Only the group owner can modify group info' },
        { status: 403 }
      )
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json(
        { error: 'The group has been dissolved', code: 'GROUP_DISSOLVED' },
        { status: 403 }
      )
    case 'premium_change_unsupported':
      return NextResponse.json(
        {
          error: 'Premium access mode cannot be changed through a profile edit',
          code: 'PREMIUM_CHANGE_UNSUPPORTED',
        },
        { status: 409 }
      )
    case 'name_taken':
      return NextResponse.json(
        { error: 'A group with this name already exists', code: 'NAME_TAKEN' },
        { status: 409 }
      )
    case 'pending_exists':
      return NextResponse.json(
        { error: 'You already have a pending edit application' },
        { status: 409 }
      )
    case 'operation_conflict':
      return NextResponse.json(
        { error: 'Operation id conflicts with another request' },
        { status: 409 }
      )
    default:
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
  }
}

function matchesSubmittedApplication(
  input: GroupEditApplicationInput,
  application: Extract<SubmitGroupEditApplicationResult, { status: 'submitted' }>['application'],
  groupId: string,
  actorId: string
): boolean {
  return (
    application.group_id === groupId &&
    application.applicant_id === actorId &&
    application.name === input.name &&
    application.name_en === input.name_en &&
    application.description === input.description &&
    application.description_en === input.description_en &&
    application.avatar_url === input.avatar_url &&
    jsonValuesEqual(application.role_names, input.role_names) &&
    jsonValuesEqual(application.rules_json, input.rules_json) &&
    application.rules === input.rules &&
    application.is_premium_only === input.is_premium_only
  )
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key])
    )
  )
}

// 提交小组信息修改申请
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedGroupId = groupEditGroupIdSchema.safeParse(extractGroupId(request.url))
    if (!parsedGroupId.success) {
      return NextResponse.json({ error: 'Invalid group id' }, { status: 400 })
    }
    const groupId = parsedGroupId.data
    const sb: SupabaseClient<Database> = supabase

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = groupEditApplicationInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid edit application' }, { status: 400 })
    }
    const input = parsedBody.data

    const { data, error } = await sb.rpc('submit_group_edit_application_atomic', {
      p_actor_id: user.id,
      p_group_id: groupId,
      p_name: input.name,
      p_name_en: input.name_en,
      p_description: input.description,
      p_description_en: input.description_en,
      p_avatar_url: input.avatar_url,
      p_role_names: input.role_names,
      p_rules_json: input.rules_json,
      p_rules: input.rules,
      p_is_premium_only: input.is_premium_only,
      p_operation_id: input.operation_id,
    })

    if (error) {
      logger.error('Atomic group edit application submission failed', {
        error,
        groupId,
        actorId: user.id,
      })
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    const parsedResult = submitGroupEditApplicationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group edit application submission returned an invalid result', {
        groupId,
        actorId: user.id,
      })
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    const result = parsedResult.data
    if (result.status !== 'submitted') return submitFailureResponse(result)
    if (
      result.operation_id !== input.operation_id ||
      !matchesSubmittedApplication(input, result.application, groupId, user.id)
    ) {
      logger.error(
        'Atomic group edit application submission returned a mismatched acknowledgement',
        {
          groupId,
          actorId: user.id,
        }
      )
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Edit application submitted, pending admin review',
      operation_id: result.operation_id,
      application: result.application,
    })
  },
  { name: 'groups/edit-apply-post', rateLimit: 'write' }
)

// 获取小组的修改申请列表（组长可查看）
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedGroupId = groupEditGroupIdSchema.safeParse(extractGroupId(request.url))
    if (!parsedGroupId.success) {
      return NextResponse.json({ error: 'Invalid group id' }, { status: 400 })
    }
    const groupId = parsedGroupId.data
    const sb: SupabaseClient<Database> = supabase

    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return privateJson({ error: 'Invalid edit application request' }, 400)
    }
    const input = readListInput(url)
    const actorId = CanonicalUuidSchema.safeParse(user.id)
    if (!input) return privateJson({ error: 'Invalid edit application request' }, 400)
    if (!actorId.success) return privateJson({ error: 'Permission denied' }, 403)

    const { data, error } = await sb.rpc('get_group_edit_applications_page_atomic', {
      p_actor_id: actorId.data,
      p_group_id: groupId,
      p_before_created_at: input.cursor?.created_at ?? null,
      p_before_id: input.cursor?.id ?? null,
      p_limit: input.limit,
    })

    if (error) {
      logger.error('Atomic group edit-application page query failed', {
        groupId,
        actorId: actorId.data,
        error,
      })
      return privateJson({ error: 'Fetch failed' }, 500)
    }

    const parsedResult = ListResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group edit-application page returned an invalid result', {
        groupId,
        actorId: actorId.data,
      })
      return privateJson({ error: 'Fetch failed' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return listFailureResponse(result.reason)
    if (!matchesListRequest(result, actorId.data, groupId, input)) {
      logger.error('Atomic group edit-application page returned mismatched evidence', {
        groupId,
        actorId: actorId.data,
      })
      return privateJson({ error: 'Fetch failed' }, 500)
    }

    const last = result.applications.at(-1)
    const nextCursor =
      result.has_more && last
        ? encodeListCursor({ created_at: last.created_at, id: last.id })
        : null

    return privateJson({
      applications: result.applications,
      pagination: {
        limit: input.limit,
        has_more: result.has_more,
        next_cursor: nextCursor,
      },
    })
  },
  { name: 'groups/edit-apply-get', rateLimit: 'read' }
)
