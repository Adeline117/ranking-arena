import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
)

export async function GET(req: NextRequest) {
  try {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category') || ''
  const search = (searchParams.get('search') || '').slice(0, 200) // cap search length
  const lang = searchParams.get('language') || ''  // user's UI language preference
  const page = Math.max(1, parseInt(searchParams.get('page') || '1') || 1)
  const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '24') || 24), 100)
  const offset = (page - 1) * limit

  // Use RPC for language-priority sorting when user has a language preference
  if (lang && !search) {
    // Preferred language items first, then others, both sorted by view_count
    const preferredLang = lang === 'zh' ? 'zh' : 'en'
    const { data, error, count } = await supabase.rpc('library_items_by_lang', {
      p_category: category && category !== 'all' ? category : null,
      p_preferred_lang: preferredLang,
      p_limit: limit,
      p_offset: offset,
    })

    if (error) {
      // Fallback to simple query if RPC doesn't exist
      console.warn('RPC fallback:', error.message)
    } else {
      // Get total count separately
      let countQuery = supabase.from('library_items').select('*', { count: 'exact', head: true })
      if (category && category !== 'all') countQuery = countQuery.eq('category', category)
      const { count: total } = await countQuery
      return NextResponse.json({
        items: data || [],
        total: total || 0,
        page,
        totalPages: Math.ceil((total || 0) / limit),
      })
    }
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

  query = query.order('view_count', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    items: data || [],
    total: count || 0,
    page,
    totalPages: Math.ceil((count || 0) / limit),
  })
  } catch (e) {
    console.error('Library API error:', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
