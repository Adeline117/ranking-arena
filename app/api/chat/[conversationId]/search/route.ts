/**
 * Chat Message Search API
 * GET /api/chat/[conversationId]/search?q=...&limit=...&cursor=...&from=...&to=...
 *
 * Searches messages in a conversation with pagination.
 * Only conversation members can search.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, notFound, forbidden, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'
import { parseLimit } from '@/lib/utils/safe-parse'

const logger = createLogger('chat-search')

export const dynamic = 'force-dynamic'

// Next.js dynamic route params must be extracted from the raw handler signature.
// withAuth wraps the handler so we extract params from the URL path instead.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const resolvedParams = params instanceof Promise ? await params : params
  const conversationId = resolvedParams.conversationId

  // Delegate to the withAuth-wrapped handler, passing conversationId via URL
  // Since withAuth expects (request: NextRequest) => Promise<NextResponse>,
  // we create the handler inline with the captured conversationId.
  const handler = withAuth(async ({ user, supabase, request: req }) => {
    const searchParams = req.nextUrl.searchParams
    const query = searchParams.get('q')
    const limit = parseLimit(searchParams.get('limit'), 20, 50)
    const cursor = searchParams.get('cursor') // message created_at for pagination
    const fromDate = searchParams.get('from') // optional: filter start date
    const toDate = searchParams.get('to') // optional: filter end date

    if (!query || query.trim().length === 0) {
      return badRequest('Search query cannot be empty')
    }

    // Verify user is a member of this conversation
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id')
      .eq('id', conversationId)
      .maybeSingle()

    if (convError || !conversation) {
      return notFound('Conversation not found')
    }

    if (conversation.user1_id !== user.id && conversation.user2_id !== user.id) {
      return forbidden('No permission to access this conversation')
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
      logger.error('Query error', { error: searchError })
      return serverError('Search failed')
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

    // Backward-compatible response shape
    return NextResponse.json({
      matches,
      next_cursor: nextCursor,
      total_in_page: matches.length,
    })
  }, { name: 'chat-search', rateLimit: 'authenticated' })

  return handler(request)
}
