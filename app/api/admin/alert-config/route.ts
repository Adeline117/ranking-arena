/**
 * 报警配置 API
 * GET /api/admin/alert-config - 获取报警配置
 * POST /api/admin/alert-config - 更新报警配置
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  
  if (!url || !key) {
    throw new Error('Supabase env missing')
  }
  
  return createClient(url, key, { auth: { persistSession: false } })
}

async function verifyAdmin(supabase: ReturnType<typeof getSupabaseAdmin>, authHeader: string | null) {
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }
  
  const token = authHeader.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  
  if (error || !user) {
    return null
  }
  
  // Check if user is admin
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()
  
  if (profile?.role !== 'admin') {
    return null
  }
  
  return user
}

export async function GET(req: Request) {
  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const { data: configs, error } = await supabase
      .from('alert_config')
      .select('*')
      .order('key')
    
    if (error) {
      console.error('Error fetching alert config:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    // Transform to object format
    const configMap: Record<string, { value: string | null; enabled: boolean }> = {}
    for (const config of configs || []) {
      configMap[config.key] = {
        value: config.value,
        enabled: config.enabled,
      }
    }
    
    return NextResponse.json({
      ok: true,
      config: configMap,
    })
  } catch (error: any) {
    console.error('Alert config API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const body = await req.json()
    const { key, value, enabled } = body
    
    if (!key) {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 })
    }
    
    // Validate key
    const validKeys = ['slack_webhook_url', 'feishu_webhook_url', 'alert_email']
    if (!validKeys.includes(key)) {
      return NextResponse.json({ error: 'Invalid config key' }, { status: 400 })
    }
    
    // Upsert the config
    const { error } = await supabase
      .from('alert_config')
      .upsert({
        key,
        value: value || null,
        enabled: enabled ?? false,
        updated_at: new Date().toISOString(),
        updated_by: admin.id,
      }, { onConflict: 'key' })
    
    if (error) {
      console.error('Error updating alert config:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    // Log the action
    await supabase.from('admin_logs').insert({
      admin_id: admin.id,
      action: 'update_alert_config',
      target_type: 'config',
      details: { key, enabled },
    })
    
    return NextResponse.json({
      ok: true,
      message: 'Config updated successfully',
    })
  } catch (error: any) {
    console.error('Alert config API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
