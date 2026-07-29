import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'

const UuidSchema = z.string().uuid()

type AtomicDeleteResult =
  | {
      success: true
      deleted: boolean
      alreadyDeleted: boolean
      messageId: string
      conversationId: string
      deletedAt: string
      lastMessageAt: string
      lastMessagePreview: string | null
    }
  | { success: false; reason: 'FORBIDDEN' | 'NOT_FOUND' }

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readAtomicDeleteResult(value: unknown): AtomicDeleteResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (result.success === false) {
    if (
      !exactKeys(result, ['deleted', 'reason', 'success']) ||
      result.deleted !== false ||
      (result.reason !== 'FORBIDDEN' && result.reason !== 'NOT_FOUND')
    ) {
      return null
    }
    return { success: false, reason: result.reason }
  }

  if (
    result.success !== true ||
    !exactKeys(result, [
      'already_deleted',
      'conversation_id',
      'deleted',
      'deleted_at',
      'last_message_at',
      'last_message_preview',
      'message_id',
      'success',
    ]) ||
    typeof result.deleted !== 'boolean' ||
    typeof result.already_deleted !== 'boolean' ||
    result.deleted === result.already_deleted ||
    !UuidSchema.safeParse(result.message_id).success ||
    !UuidSchema.safeParse(result.conversation_id).success ||
    !isTimestamp(result.deleted_at) ||
    !isTimestamp(result.last_message_at) ||
    !(result.last_message_preview === null || typeof result.last_message_preview === 'string')
  ) {
    return null
  }

  return {
    success: true,
    deleted: result.deleted,
    alreadyDeleted: result.already_deleted,
    messageId: result.message_id as string,
    conversationId: result.conversation_id as string,
    deletedAt: result.deleted_at,
    lastMessageAt: result.last_message_at,
    lastMessagePreview: result.last_message_preview as string | null,
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const parsedMessageId = UuidSchema.safeParse((await params).messageId)
    if (!parsedMessageId.success) {
      return NextResponse.json({ error: 'Invalid message id' }, { status: 400 })
    }
    const messageId = parsedMessageId.data
    const supabase = getSupabaseAdmin()

    // Ownership, immutable participant identity, soft deletion and the
    // conversation preview must commit together. The former pre-read followed
    // by a service-role update was a TOCTOU boundary and returned success even
    // when no exact owned row was changed.
    const { data, error } = await supabase.rpc('delete_direct_message_atomic', {
      p_message_id: messageId,
      p_actor_id: user.id,
    })

    if (error) {
      logger.error('Atomic direct-message delete failed', { code: error.code, messageId })
      return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
    }

    const result = readAtomicDeleteResult(data)
    if (!result) {
      logger.error('Atomic direct-message delete returned malformed evidence', { messageId })
      return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
    }
    if (!result.success) {
      if (result.reason === 'NOT_FOUND') {
        return NextResponse.json({ error: 'Message not found' }, { status: 404 })
      }
      return NextResponse.json({ error: 'Cannot delete others messages' }, { status: 403 })
    }
    if (result.messageId !== messageId) {
      logger.error('Atomic direct-message delete acknowledged the wrong message', {
        expectedMessageId: messageId,
        acknowledgedMessageId: result.messageId,
      })
      return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      already_deleted: result.alreadyDeleted,
      message_id: result.messageId,
      conversation_id: result.conversationId,
      deleted_at: result.deletedAt,
      last_message_at: result.lastMessageAt,
      last_message_preview: result.lastMessagePreview,
    })
  } catch (err) {
    logger.error('Delete message API error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
