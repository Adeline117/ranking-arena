import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/admin/auth'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = getSupabaseAdmin()

    // 1. Find users who rated this book ≥4
    const { data: highRaters } = await supabase
      .from('book_ratings')
      .select('user_id')
      .eq('library_item_id', id)
      .eq('status', 'read')
      .gte('rating', 4)

    const userIds = (highRaters || []).map((r: any) => r.user_id)

    let results: { id: string; title: string; author: string | null; cover_url: string | null; rating: number | null; rating_count: number | null; count: number }[] = []

    if (userIds.length > 0) {
      // 2. Find other books these users also rated ≥4
      const { data: otherRatings } = await supabase
        .from('book_ratings')
        .select('library_item_id')
        .in('user_id', userIds)
        .eq('status', 'read')
        .gte('rating', 4)
        .neq('library_item_id', id)

      if (otherRatings && otherRatings.length > 0) {
        // 3. Count frequency
        const freq: Record<string, number> = {}
        for (const r of otherRatings) {
          freq[r.library_item_id] = (freq[r.library_item_id] || 0) + 1
        }
        const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8)
        const topIds = sorted.map(([bid]) => bid)

        if (topIds.length > 0) {
          const { data: books } = await supabase
            .from('library_items')
            .select('id, title, author, cover_url, rating, rating_count')
            .in('id', topIds)

          if (books) {
            const freqMap = Object.fromEntries(sorted)
            results = books.map((b: any) => ({ ...b, count: freqMap[b.id] || 0 }))
            results.sort((a, b) => b.count - a.count)
          }
        }
      }
    }

    // 4. Fallback if < 4 results
    if (results.length < 4) {
      const existingIds = new Set([id, ...results.map(r => r.id)])

      const { data: currentBook } = await supabase
        .from('library_items')
        .select('category, tags')
        .eq('id', id)
        .single()

      if (currentBook) {
        const needed = 8 - results.length
        let query = supabase
          .from('library_items')
          .select('id, title, author, cover_url, rating, rating_count')
          .eq('category', currentBook.category)
          .not('id', 'in', `(${[...existingIds].join(',')})`)
          .not('rating', 'is', null)
          .order('rating', { ascending: false })
          .limit(needed)

        const { data: fallback } = await query
        if (fallback) {
          results.push(...fallback.map((b: any) => ({ ...b, count: 0 })))
        }
      }
    }

    return NextResponse.json({ books: results.slice(0, 8) })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
