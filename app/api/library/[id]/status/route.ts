import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'
import { z } from 'zod'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const StatusSchema = z.object({
  status: z.enum(['want_to_read', 'reading', 'read']),
})

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await params
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.substring(7))
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const parsed = StatusSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid status', details: parsed.error.flatten() }, { status: 400 })
    }

    const { status } = parsed.data

    // Upsert - if switching to want_to_read, clear rating
    const upsertData: { user_id: string; library_item_id: string; status: string; updated_at: string; rating?: null } = {
      user_id: user.id,
      library_item_id: id,
      status,
      updated_at: new Date().toISOString(),
    }

    if (status === 'want_to_read') {
      upsertData.rating = null
    }

    const { error } = await supabase
      .from('book_ratings')
      .upsert(upsertData, { onConflict: 'user_id,library_item_id' })

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // Auto-generate a post (豆瓣式) when marking a book
    try {
      const { data: item } = await supabase
        .from('library_items')
        .select('title, title_zh, author, cover_url, category')
        .eq('id', id)
        .maybeSingle()

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle, nickname')
        .eq('id', user.id)
        .maybeSingle()

      if (item && profile) {
        const bookTitle = item.title_zh || item.title || ''
        const statusLabel: Record<string, { zh: string; en: string }> = {
          want_to_read: { zh: '想读', en: 'wants to read' },
          reading: { zh: '在读', en: 'is reading' },
          read: { zh: '读过', en: 'has read' },
        }
        const label = statusLabel[status] || statusLabel.want_to_read
        const displayName = profile.nickname || profile.handle || 'User'

        const content = `${label.zh}《${bookTitle}》${item.author ? ` — ${item.author}` : ''}`

        // Check if already posted for this book+status combo (avoid duplicates)
        const { data: existing } = await supabase
          .from('posts')
          .select('id')
          .eq('author_id', user.id)
          .eq('metadata->>library_item_id', id)
          .eq('metadata->>status_type', status)
          .limit(1)

        if (!existing?.length) {
          await supabase.from('posts').insert({
            author_id: user.id,
            author_handle: profile.handle,
            content,
            category: 'activity',
            metadata: {
              type: 'book_status',
              library_item_id: id,
              status_type: status,
              book_title: bookTitle,
              book_author: item.author,
              cover_url: item.cover_url,
            },
          })
        }
      }
    } catch {
      // Non-critical: don't fail the status update if post creation fails
    }

    return NextResponse.json({ success: true, status })
  } catch (e: unknown) {
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)) }, { status: 500 })
  }
}
