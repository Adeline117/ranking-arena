import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

export async function GET(req: NextRequest) {
  try {
  // Rate limit: 60 req/min
  const rateLimitResponse = await checkRateLimit(req, RateLimitPresets.search)
  if (rateLimitResponse) return rateLimitResponse
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category') || ''
  const search = (searchParams.get('search') || '').slice(0, 200) // cap search length
  const lang = searchParams.get('language') || ''  // user's UI language preference
  const sort = searchParams.get('sort') || 'recent'
  const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1)
  const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '24') || 24), 100)
  const offset = (page - 1) * limit

  // Use tiered cache (memory → Redis → DB)
  const cacheKey = `api:library:${category}:${search}:${lang}:${sort}:${page}:${limit}`
  const result = await tieredGetOrSet(
    cacheKey,
    () => fetchLibraryData({ category, search, lang, sort, page, limit, offset }),
    search ? 'warm' : 'cold',
    ['library']
  )

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' }
  })
  } catch (e) {
    console.error('Library API error:', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

async function fetchLibraryData({ category, search, lang, sort, page, limit, offset }: {
  category: string; search: string; lang: string; sort: string; page: number; limit: number; offset: number
}) {
  // Use RPC for language-priority sorting when user has a language preference
  if (lang && !search) {
    // Preferred language items first, then others, sorted by creation date
    const preferredLang = lang === 'zh' ? 'zh' : 'en'
    const { data, error, count } = await supabase.rpc('library_items_by_lang', {
      p_category: category && category !== 'all' ? category : null,
      p_preferred_lang: preferredLang,
      p_limit: limit,
      p_offset: offset,
    })

    if (!error) {
      // Get total count separately
      let countQuery = supabase.from('library_items').select('*', { count: 'exact', head: true })
      if (category && category !== 'all') countQuery = countQuery.eq('category', category)
      const { count: total } = await countQuery
      return {
        items: data || [],
        total: total || 0,
        page,
        totalPages: Math.ceil((total || 0) / limit),
      }
    }
    // Fallback to simple query if RPC doesn't exist
    console.warn('RPC fallback:', error.message)
  }

  let query = supabase
    .from('library_items')
    .select('*', { count: 'exact' })

  if (category && category !== 'all') {
    query = query.eq('category', category)
  }

  if (search) {
    query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%,author.ilike.%${search}%`)
  }

  // Apply sort order
  switch (sort) {
    case 'popular':
      query = query.order('view_count', { ascending: false, nullsFirst: false })
      break
    case 'rating':
      query = query.order('rating', { ascending: false, nullsFirst: false })
      break
    case 'date':
      query = query.order('publish_date', { ascending: false, nullsFirst: false })
      break
    case 'recent':
    default:
      query = query.order('created_at', { ascending: false })
      break
  }

  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    throw new Error(error.message)
  }

  return {
    items: data || [],
    total: count || 0,
    page,
    totalPages: Math.ceil((count || 0) / limit),
  }
}
