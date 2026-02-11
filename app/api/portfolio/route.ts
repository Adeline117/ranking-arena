/**
 * Portfolio CRUD API
 * GET /api/portfolio - List user portfolios
 * POST /api/portfolio - Add exchange connection
 * DELETE /api/portfolio?id=xxx - Remove exchange connection
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_portfolios')
      .select('id, exchange, label, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) throw error

    return success(data || [])
  } catch (err) {
    return handleError(err)
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const body = await request.json()

    const { exchange, api_key, api_secret, label } = body
    if (!exchange || !api_key || !api_secret) {
      return NextResponse.json({ error: 'Missing required fields: exchange, api_key, api_secret' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    const { data, error } = await supabase
      .from('user_portfolios')
      .insert({
        user_id: user.id,
        exchange,
        api_key_encrypted: api_key, // TODO: encrypt before storage
        api_secret_encrypted: api_secret, // TODO: encrypt before storage
        label: label || exchange,
      })
      .select('id, exchange, label, created_at')
      .single()

    if (error) throw error

    return success(data, 201)
  } catch (err) {
    return handleError(err)
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) {
      return NextResponse.json({ error: 'Missing portfolio id' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Verify ownership
    const { data: portfolio } = await supabase
      .from('user_portfolios')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!portfolio) {
      return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })
    }

    const { error } = await supabase
      .from('user_portfolios')
      .delete()
      .eq('id', id)

    if (error) throw error

    return success({ deleted: true })
  } catch (err) {
    return handleError(err)
  }
}
