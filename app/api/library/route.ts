import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import logger from '@/lib/logger'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

// Only select fields the frontend needs (avoid transferring large text fields like ai_summary)
const LIBRARY_LIST_FIELDS = 'id,title,title_en,title_zh,author,description,category,subcategory,cover_url,language,tags,publish_date,rating,rating_count,view_count,download_count,is_free,pdf_url,file_key,created_at'

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
    search ? 'warm' : 'hot',  // 无搜索词时用 hot 层 (Redis 300s)，有搜索词用 warm 层
    ['library']
  )

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' }
  })
  } catch (e) {
    logger.error('Library API error:', e)
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
    // Run data fetch and count query in parallel
    let countQuery = supabase.from('library_items').select('id', { count: 'exact', head: true })
    if (category && category !== 'all') countQuery = countQuery.eq('category', category)

    const [rpcResult, countResult] = await Promise.all([
      supabase.rpc('library_items_by_lang', {
        p_category: category && category !== 'all' ? category : null,
        p_preferred_lang: preferredLang,
        p_limit: limit,
        p_offset: offset,
      }),
      countQuery,
    ])

    if (!rpcResult.error && rpcResult.data) {
      const total = countResult.count || 0
      return {
        items: rpcResult.data,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      }
    }
    // Fallback to simple query if RPC doesn't exist
    logger.warn('RPC fallback:', rpcResult.error?.message)
  }

  let query = supabase
    .from('library_items')
    .select(LIBRARY_LIST_FIELDS, { count: 'exact' })

  if (category && category !== 'all') {
    query = query.eq('category', category)
  }

  if (search) {
    // Sanitize search input to prevent PostgREST query errors
    const safeSearch = search.replace(/[\\%_]/g, c => `\\${c}`).replace(/[.,()]/g, '')
    if (!safeSearch) {
      return { items: [], total: 0, page, totalPages: 0 }
    }
    query = query.or(`title.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%,author.ilike.%${safeSearch}%`)
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
