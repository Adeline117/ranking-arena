import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'
import { z } from 'zod'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const RateSchema = z.object({
  rating: z.number().int().min(1).max(5).optional().nullable(),
  review: z.string().max(280).optional().nullable(),
  status: z.enum(['want_to_read', 'reading', 'read']).optional(),
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
    const parsed = RateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.flatten() }, { status: 400 })
    }

    const { rating, review, status } = parsed.data
    const effectiveStatus = status || 'read'

    if (effectiveStatus === 'read') {
      if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
        return NextResponse.json({ error: 'Rating must be 1-5 for read status' }, { status: 400 })
      }
    }

    if (effectiveStatus === 'want_to_read' && rating) {
      return NextResponse.json({ error: 'Cannot rate a book you have not read' }, { status: 400 })
    }

    // Upsert rating
    const { error: upsertError } = await supabase
      .from('book_ratings')
      .upsert({
        user_id: user.id,
        library_item_id: id,
        rating: effectiveStatus === 'want_to_read' ? null : rating,
        review: review || null,
        status: effectiveStatus,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,library_item_id' })

    if (upsertError) {
      return NextResponse.json({ error: upsertError.message }, { status: 500 })
    }

    // Get updated rating + book info
    const { data: item } = await supabase
      .from('library_items')
      .select('title, title_zh, author, cover_url, rating, rating_count')
      .eq('id', id)
      .single()

    // Auto-generate post for "read" with rating (豆瓣式)
    if (effectiveStatus === 'read' && rating && item) {
      try {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('handle, nickname')
          .eq('id', user.id)
          .maybeSingle()

        if (profile) {
          const bookTitle = item.title_zh || item.title || ''
          const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating)
          const content = `读过《${bookTitle}》${item.author ? ` — ${item.author}` : ''}\n${stars} ${rating}/5${review ? `\n\n${review}` : ''}`

          // Update existing post or create new one
          const { data: existing } = await supabase
            .from('posts')
            .select('id')
            .eq('author_id', user.id)
            .eq('metadata->>library_item_id', id)
            .eq('metadata->>status_type', 'read')
            .limit(1)

          if (existing?.length) {
            await supabase.from('posts').update({
              content,
              metadata: {
                type: 'book_status',
                library_item_id: id,
                status_type: 'read',
                book_title: bookTitle,
                book_author: item.author,
                cover_url: item.cover_url,
                rating,
                review: review || null,
              },
              updated_at: new Date().toISOString(),
            }).eq('id', existing[0].id)
          } else {
            await supabase.from('posts').insert({
              author_id: user.id,
              author_handle: profile.handle,
              content,
              category: 'activity',
              metadata: {
                type: 'book_status',
                library_item_id: id,
                status_type: 'read',
                book_title: bookTitle,
                book_author: item.author,
                cover_url: item.cover_url,
                rating,
                review: review || null,
              },
            })
          }
        }
      } catch {
        // Non-critical
      }
    }

    return NextResponse.json({
      success: true,
      rating: item?.rating,
      rating_count: item?.rating_count,
    })
  } catch (e: unknown) {
    return NextResponse.json({ error: (e instanceof Error ? e.message : String(e)) }, { status: 500 })
  }
}
