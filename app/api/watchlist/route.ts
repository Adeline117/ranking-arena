/**
 * Trader Watchlist API
 *
 * GET  — list user's watchlist
 * POST — add trader to watchlist
 * DELETE — remove trader from watchlist (via body: { source, source_trader_id })
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAuthenticatedUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7) // access token
}

function getSupabaseWithAuth(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

export async function GET(request: NextRequest) {
  const token = getAuthenticatedUser(request)
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseWithAuth(token)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabase
    .from('trader_watchlist')
    .select('source, source_trader_id, handle, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ watchlist: data || [] })
}

export async function POST(request: NextRequest) {
  const token = getAuthenticatedUser(request)
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseWithAuth(token)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { source, source_trader_id, handle } = body

  if (!source || !source_trader_id || typeof source !== 'string' || typeof source_trader_id !== 'string') {
    return NextResponse.json({ error: 'source and source_trader_id required (strings)' }, { status: 400 })
  }
  if (source.length > 50 || source_trader_id.length > 200) {
    return NextResponse.json({ error: 'Invalid input length' }, { status: 400 })
  }

  // Enforce max watchlist size (200)
  const { count } = await supabase
    .from('trader_watchlist')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
  if ((count ?? 0) >= 200) {
    return NextResponse.json({ error: 'Watchlist full (max 200)' }, { status: 400 })
  }

  const { error } = await supabase
    .from('trader_watchlist')
    .upsert({
      user_id: user.id,
      source,
      source_trader_id,
      handle: handle || null,
    }, {
      onConflict: 'user_id,source,source_trader_id',
    })

  if (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const token = getAuthenticatedUser(request)
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseWithAuth(token)
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { source, source_trader_id } = body

  if (!source || !source_trader_id) {
    return NextResponse.json({ error: 'source and source_trader_id required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('trader_watchlist')
    .delete()
    .eq('user_id', user.id)
    .eq('source', source)
    .eq('source_trader_id', source_trader_id)

  if (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
