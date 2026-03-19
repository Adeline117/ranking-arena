/**
 * Trader Comments API
 * GET  /api/traders/[handle]/comments - List comments for a trader or user profile
 * POST /api/traders/[handle]/comments - Create a comment (auth required)
 * DELETE /api/traders/[handle]/comments - Delete own comment (auth required)
 *
 * Supports both trader pages and user profile pages:
 * - Trader page: source=binance_futures&source_id=ABC123
 * - User profile: source=user&source_id=<user_uuid>
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  getSupabaseAdmin,
  requireAuth,
  getAuthUser,
  success,
  successWithPagination,
  handleError,
  validateNumber,
  ApiError,
} from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const CreateCommentSchema = z.object({
  content: z.string().min(1, 'Comment is required').max(2000, 'Comment must be at most 2000 characters'),
  trader_source: z.string().min(1),
  trader_source_id: z.string().min(1),
})

const DeleteCommentSchema = z.object({
  comment_id: z.string().uuid('Invalid comment ID'),
})

type RouteContext = { params: Promise<{ handle: string }> }

export async function GET(request: NextRequest, _context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { searchParams } = new URL(request.url)
    const traderSource = searchParams.get('source')
    const traderSourceId = searchParams.get('source_id')

    if (!traderSource || !traderSourceId) {
      throw ApiError.validation('source and source_id are required')
    }

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0

    const supabase = getSupabaseAdmin()

    const { data: comments, error } = await supabase
      .from('trader_comments')
      .select('id, content, created_at, updated_at, user_id')
      .eq('trader_source', traderSource)
      .eq('trader_source_id', traderSourceId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    // Fetch user profiles for comment authors
    const userIds = [...new Set((comments || []).map(c => c.user_id))]
    let profileMap: Record<string, { handle: string | null; avatar_url: string | null }> = {}

    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url')
        .in('id', userIds)

      if (profiles) {
        profileMap = Object.fromEntries(
          profiles.map(p => [p.id, { handle: p.handle, avatar_url: p.avatar_url }])
        )
      }
    }

    const enrichedComments = (comments || []).map(c => ({
      id: c.id,
      content: c.content,
      created_at: c.created_at,
      updated_at: c.updated_at,
      user_id: c.user_id,
      author_handle: profileMap[c.user_id]?.handle || null,
      author_avatar_url: profileMap[c.user_id]?.avatar_url || null,
    }))

    return successWithPagination(
      { comments: enrichedComments },
      { limit, offset, has_more: (comments || []).length === limit }
    )
  } catch (error: unknown) {
    return handleError(error, 'traders/[handle]/comments GET')
  }
}

export async function POST(request: NextRequest, _context: RouteContext) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const parsed = CreateCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }

    const { content, trader_source, trader_source_id } = parsed.data

    const { data: comment, error } = await supabase
      .from('trader_comments')
      .insert({
        trader_source,
        trader_source_id,
        user_id: user.id,
        content,
      })
      .select('id, content, created_at, updated_at, user_id')
      .single()

    if (error) throw error

    // Fetch author profile
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle, avatar_url')
      .eq('id', user.id)
      .maybeSingle()

    return success({
      comment: {
        ...comment,
        author_handle: profile?.handle || null,
        author_avatar_url: profile?.avatar_url || null,
      },
    }, 201)
  } catch (error: unknown) {
    return handleError(error, 'traders/[handle]/comments POST')
  }
}

export async function DELETE(request: NextRequest, _context: RouteContext) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const parsed = DeleteCommentSchema.safeParse(body)
    if (!parsed.success) {
      throw ApiError.validation('Invalid input', { errors: parsed.error.flatten() })
    }

    // Verify ownership
    const { data: existing } = await supabase
      .from('trader_comments')
      .select('user_id')
      .eq('id', parsed.data.comment_id)
      .single()

    if (!existing) {
      throw ApiError.notFound('Comment not found')
    }
    if (existing.user_id !== user.id) {
      throw ApiError.forbidden('You can only delete your own comments')
    }

    const { error } = await supabase
      .from('trader_comments')
      .delete()
      .eq('id', parsed.data.comment_id)

    if (error) throw error

    return success({ message: 'Comment deleted' })
  } catch (error: unknown) {
    return handleError(error, 'traders/[handle]/comments DELETE')
  }
}
