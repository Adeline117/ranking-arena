/**
 * Chat Message Search API
 * GET /api/chat/[conversationId]/search?q=...&limit=...&cursor=...&from=...&to=...
 *
 * Searches messages in a conversation with pagination.
 * Only conversation members can search.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { parseLimit } from '@/lib/utils/safe-parse'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  try {
    // Authenticate user
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolvedParams = params instanceof Promise ? await params : params
    const conversationId = resolvedParams.conversationId

    const searchParams = request.nextUrl.searchParams
    const query = searchParams.get('q')
    const limit = parseLimit(searchParams.get('limit'), 20, 50)
    const cursor = searchParams.get('cursor') // message created_at for pagination
    const fromDate = searchParams.get('from') // optional: filter start date
    const toDate = searchParams.get('to') // optional: filter end date

    if (!query || query.trim().length === 0) {
      return NextResponse.json({ error: 'Search query cannot be empty' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Verify user is a member of this conversation
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id')
      .eq('id', conversationId)
      .maybeSingle()

    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    if (conversation.user1_id !== user.id && conversation.user2_id !== user.id) {
      return NextResponse.json({ error: 'No permission to access this conversation' }, { status: 403 })
    }

    // Check if user has cleared history - only show messages after cleared_before
    const { data: memberSettings } = await supabase
      .from('conversation_members')
      .select('cleared_before')
      .eq('conversation_id', conversationId)
      .eq('user_id', user.id)
      .maybeSingle()

    // Build search query
    let searchQuery = supabase
      .from('direct_messages')
      .select('id, content, created_at, sender_id')
      .eq('conversation_id', conversationId)
      .ilike('content', `%${query.trim()}%`)

    // Apply cleared_before filter
    if (memberSettings?.cleared_before) {
      searchQuery = searchQuery.gt('created_at', memberSettings.cleared_before)
    }

    // Apply date range filters
    if (fromDate) {
      searchQuery = searchQuery.gte('created_at', fromDate)
    }
    if (toDate) {
      searchQuery = searchQuery.lte('created_at', toDate)
    }

    // Apply cursor-based pagination
    if (cursor) {
      searchQuery = searchQuery.lt('created_at', cursor)
    }

    // Order and limit must be last
    searchQuery = searchQuery.order('created_at', { ascending: false })

    const { data: messages, error: searchError } = await searchQuery.limit(limit + 1)

    if (searchError) {
      logger.error('[Chat Search] Query error:', searchError)
      return NextResponse.json({ error: 'Search failed' }, { status: 500 })
    }

    // Determine if there's a next page
    const hasMore = (messages?.length || 0) > limit
    const results = (messages || []).slice(0, limit)

    // Generate snippets with context around the match
    const matches = results.map(msg => {
      const content = msg.content
      const lowerContent = content.toLowerCase()
      const lowerQuery = query.trim().toLowerCase()
      const matchIndex = lowerContent.indexOf(lowerQuery)

      let snippet = content
      if (content.length > 100) {
        const start = Math.max(0, matchIndex - 40)
        const end = Math.min(content.length, matchIndex + query.trim().length + 40)
        snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '')
      }

      return {
        message_id: msg.id,
        snippet,
        created_at: msg.created_at,
        sender_id: msg.sender_id,
      }
    })

    const nextCursor = hasMore && results.length > 0
      ? results[results.length - 1].created_at
      : null

    return NextResponse.json({
      matches,
      next_cursor: nextCursor,
      total_in_page: matches.length,
    })
  } catch (error: unknown) {
    logger.error('[Chat Search] Error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
