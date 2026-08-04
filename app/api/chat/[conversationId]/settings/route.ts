/**
 * Chat Conversation Settings API
 * GET /api/chat/[conversationId]/settings - Get current settings
 * PATCH /api/chat/[conversationId]/settings - Update settings
 *
 * Manages per-user conversation settings: remark, mute, pin, block, clear history.
 * Only conversation members can access/modify settings.
 */

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import { invalidateFollowingCache } from '@/app/api/following/route'
import type { Database } from '@/lib/supabase/database.types'

export const dynamic = 'force-dynamic'

const PRIVATE_NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' }
const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase())
const RemarkSchema = z.union([
  z.null(),
  z
    .string()
    .max(200)
    .transform((value) => value.normalize('NFC').trim())
    .refine((value) => Array.from(value).length <= 50)
    .transform((value) => value || null),
])
const SettingsPatchSchema = z
  .object({
    remark: RemarkSchema.optional(),
    is_muted: z.boolean().optional(),
    is_pinned: z.boolean().optional(),
    is_blocked: z.boolean().optional(),
    clear_history: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0)
const AppliedFieldSchema = z.enum([
  'remark',
  'is_muted',
  'is_pinned',
  'is_blocked',
  'clear_history',
])
const ConversationSettingsSchema = z
  .object({
    remark: z
      .string()
      .max(200)
      .refine((value) => Array.from(value).length <= 50)
      .nullable(),
    is_muted: z.boolean(),
    is_pinned: z.boolean(),
    is_blocked: z.boolean(),
    cleared_before: z.string().datetime({ offset: true }).nullable(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict()
const ConversationSettingsReadSchema = z
  .object({
    remark: z
      .string()
      .max(200)
      .refine((value) => Array.from(value).length <= 50)
      .nullable(),
    is_muted: z.boolean(),
    is_pinned: z.boolean(),
    is_blocked: z.boolean(),
    cleared_before: z.string().datetime({ offset: true }).nullable(),
    updated_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
const ConversationMembershipSchema = z
  .object({
    id: CanonicalUuidSchema,
    user1_id: CanonicalUuidSchema,
    user2_id: CanonicalUuidSchema,
  })
  .strict()
const SettingsSuccessSchema = z
  .object({
    success: z.literal(true),
    actor_id: CanonicalUuidSchema,
    target_id: CanonicalUuidSchema,
    conversation_id: CanonicalUuidSchema,
    created: z.boolean(),
    applied_fields: z.array(AppliedFieldSchema).min(1).max(5),
    block_status: z
      .enum(['blocked', 'already_blocked', 'unblocked', 'already_unblocked'])
      .nullable(),
    settings: ConversationSettingsSchema,
  })
  .strict()
const SettingsFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum(['INVALID', 'NOT_FOUND', 'ACTOR_UNAVAILABLE', 'PARTICIPANT_UNAVAILABLE']),
  })
  .strict()
const SettingsResultSchema = z.discriminatedUnion('success', [
  SettingsSuccessSchema,
  SettingsFailureSchema,
])

type SettingsPatch = z.infer<typeof SettingsPatchSchema>
type SettingsFailure = z.infer<typeof SettingsFailureSchema>

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS })
}

function hasOwn<K extends keyof SettingsPatch>(value: SettingsPatch, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function extractConversationId(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/\/api\/chat\/([^/]+)\/settings\/?$/)
    return match?.[1] ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

function expectedAppliedFields(input: SettingsPatch): z.infer<typeof AppliedFieldSchema>[] {
  return (['remark', 'is_muted', 'is_pinned', 'is_blocked', 'clear_history'] as const).filter(
    (field) => hasOwn(input, field)
  )
}

function acknowledgementMatches(
  result: z.infer<typeof SettingsSuccessSchema>,
  input: SettingsPatch,
  actorId: string,
  conversationId: string
): boolean {
  const expectedFields = expectedAppliedFields(input)
  if (
    result.actor_id !== actorId ||
    result.target_id === actorId ||
    result.conversation_id !== conversationId ||
    new Set(result.applied_fields).size !== result.applied_fields.length ||
    result.applied_fields.length !== expectedFields.length ||
    expectedFields.some((field, index) => result.applied_fields[index] !== field)
  ) {
    return false
  }

  if (hasOwn(input, 'remark') && result.settings.remark !== input.remark) return false
  if (hasOwn(input, 'is_muted') && result.settings.is_muted !== input.is_muted) return false
  if (hasOwn(input, 'is_pinned') && result.settings.is_pinned !== input.is_pinned) return false
  if (hasOwn(input, 'is_blocked')) {
    const expectedStatuses = input.is_blocked
      ? new Set(['blocked', 'already_blocked'])
      : new Set(['unblocked', 'already_unblocked'])
    if (
      result.settings.is_blocked !== input.is_blocked ||
      result.block_status === null ||
      !expectedStatuses.has(result.block_status)
    ) {
      return false
    }
  } else if (result.block_status !== null) {
    return false
  }
  if (
    input.clear_history &&
    (result.settings.cleared_before === null ||
      result.settings.cleared_before !== result.settings.updated_at)
  ) {
    return false
  }

  return true
}

function failureResponse(result: SettingsFailure) {
  switch (result.reason) {
    case 'INVALID':
      return privateJson({ error: 'Invalid settings update' }, 400)
    case 'NOT_FOUND':
      return privateJson({ error: 'Conversation not found' }, 404)
    case 'ACTOR_UNAVAILABLE':
    case 'PARTICIPANT_UNAVAILABLE':
      return privateJson({ error: 'Permission denied' }, 403)
  }
}

async function verifyMembership(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  conversationId: string
) {
  const { data: conversation, error } = await supabase
    .from('conversations')
    .select('id, user1_id, user2_id')
    .eq('id', conversationId)
    .maybeSingle()

  if (error) {
    return { valid: false, status: 500, message: 'Failed to load settings' }
  }
  if (!conversation) {
    return { valid: false, status: 404, message: 'Conversation not found' }
  }

  return { valid: true, conversation }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return privateJson({ error: 'Unauthorized' }, 401)
    }

    const parsedActorId = CanonicalUuidSchema.safeParse(user.id)
    const resolvedParams = params instanceof Promise ? await params : params
    const parsedConversationId = CanonicalUuidSchema.safeParse(resolvedParams.conversationId)
    if (!parsedActorId.success || !parsedConversationId.success) {
      return privateJson({ error: 'Invalid conversation id' }, 400)
    }
    const actorId = parsedActorId.data
    const conversationId = parsedConversationId.data
    const supabase = getSupabaseAdmin()

    const membership = await verifyMembership(supabase, conversationId)
    if (!membership.valid) {
      return privateJson({ error: membership.message }, membership.status)
    }
    const parsedMembership = ConversationMembershipSchema.safeParse(membership.conversation)
    if (
      !parsedMembership.success ||
      parsedMembership.data.id !== conversationId ||
      parsedMembership.data.user1_id === parsedMembership.data.user2_id
    ) {
      logger.error('Direct-message settings read returned invalid membership evidence', {
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to load settings' }, 500)
    }
    if (parsedMembership.data.user1_id !== actorId && parsedMembership.data.user2_id !== actorId) {
      return privateJson({ error: 'No permission to access this conversation' }, 403)
    }
    const targetId =
      parsedMembership.data.user1_id === actorId
        ? parsedMembership.data.user2_id
        : parsedMembership.data.user1_id

    // Get or create member settings
    const { data: settings, error: settingsError } = await supabase
      .from('conversation_members')
      .select('remark, is_muted, is_pinned, is_blocked, cleared_before, updated_at')
      .eq('conversation_id', conversationId)
      .eq('user_id', actorId)
      .maybeSingle()

    if (settingsError) {
      logger.error('Direct-message settings read failed', { actorId, conversationId })
      return privateJson({ error: 'Failed to load settings' }, 500)
    }
    const parsedSettings =
      settings === null
        ? ConversationSettingsReadSchema.safeParse({
            remark: null,
            is_muted: false,
            is_pinned: false,
            is_blocked: false,
            cleared_before: null,
            updated_at: null,
          })
        : ConversationSettingsSchema.safeParse(settings)
    if (!parsedSettings.success) {
      logger.error('Direct-message settings read returned invalid settings evidence', {
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to load settings' }, 500)
    }

    return privateJson({
      actor_id: actorId,
      target_id: targetId,
      conversation_id: conversationId,
      settings: parsedSettings.data,
    })
  } catch (error: unknown) {
    logger.apiError('/api/chat/[conversationId]/settings', error, { method: 'GET' })
    return privateJson({ error: 'Server error' }, 500)
  }
}

export const PATCH = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedActorId = CanonicalUuidSchema.safeParse(user.id)
    const parsedConversationId = CanonicalUuidSchema.safeParse(extractConversationId(request.url))
    if (!parsedActorId.success || !parsedConversationId.success) {
      return privateJson({ error: 'Invalid conversation id' }, 400)
    }
    const actorId = parsedActorId.data
    const conversationId = parsedConversationId.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return privateJson({ error: 'Invalid JSON body' }, 400)
    }

    const parsedInput = SettingsPatchSchema.safeParse(rawBody)
    if (!parsedInput.success) {
      return privateJson({ error: 'Invalid settings update' }, 400)
    }
    const input = parsedInput.data

    const sb: SupabaseClient<Database> = supabase
    const { data, error } = await sb.rpc('mutate_direct_message_conversation_settings_atomic', {
      p_conversation_id: conversationId,
      p_actor_id: actorId,
      p_remark: hasOwn(input, 'remark') ? (input.remark ?? null) : null,
      p_remark_present: hasOwn(input, 'remark'),
      p_is_muted: hasOwn(input, 'is_muted') ? (input.is_muted ?? null) : null,
      p_is_muted_present: hasOwn(input, 'is_muted'),
      p_is_pinned: hasOwn(input, 'is_pinned') ? (input.is_pinned ?? null) : null,
      p_is_pinned_present: hasOwn(input, 'is_pinned'),
      p_is_blocked: hasOwn(input, 'is_blocked') ? (input.is_blocked ?? null) : null,
      p_is_blocked_present: hasOwn(input, 'is_blocked'),
      p_clear_history: input.clear_history === true,
    })

    if (error) {
      logger.error('Atomic direct-message settings mutation failed', {
        code: error.code,
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to update settings' }, 500)
    }

    const parsedResult = SettingsResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic direct-message settings mutation returned an invalid result', {
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to update settings' }, 500)
    }

    const result = parsedResult.data
    if (!result.success) return failureResponse(result)
    if (!acknowledgementMatches(result, input, actorId, conversationId)) {
      logger.error('Atomic direct-message settings acknowledgement mismatched its request', {
        actorId,
        conversationId,
      })
      return privateJson({ error: 'Failed to update settings' }, 500)
    }

    if (hasOwn(input, 'is_blocked')) {
      fireAndForget(
        Promise.all([
          invalidateFollowingCache(actorId),
          invalidateFollowingCache(result.target_id),
        ]),
        'Invalidate following caches after chat-settings block mutation'
      )
    }

    return privateJson({
      actor_id: result.actor_id,
      target_id: result.target_id,
      conversation_id: result.conversation_id,
      applied_fields: result.applied_fields,
      block_status: result.block_status,
      settings: result.settings,
    })
  },
  { name: 'chat-conversation-settings', rateLimit: 'write' }
)
