/**
 * 处理举报 API
 * POST /api/admin/reports/[id]/resolve
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

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const { id: reportId } = await params
    const body = await req.json()
    const { action, reason } = body
    
    // action: 'resolve' (delete content), 'dismiss' (ignore report)
    if (!['resolve', 'dismiss'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
    
    // Get the report
    const { data: report, error: reportError } = await supabase
      .from('content_reports')
      .select('*')
      .eq('id', reportId)
      .maybeSingle()
    
    if (reportError || !report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 })
    }
    
    // Check if already processed
    if (report.status !== 'pending') {
      return NextResponse.json({ error: 'Report already processed' }, { status: 400 })
    }
    
    let actionTaken = ''
    
    if (action === 'resolve') {
      // Delete the content
      if (report.content_type === 'post') {
        const { error: deleteError } = await supabase
          .from('posts')
          .delete()
          .eq('id', report.content_id)
        
        if (deleteError) {
          console.error('Error deleting post:', deleteError)
          // Content might already be deleted, continue
        }
        actionTaken = 'content_deleted'
      } else if (report.content_type === 'comment') {
        const { error: deleteError } = await supabase
          .from('comments')
          .delete()
          .eq('id', report.content_id)
        
        if (deleteError) {
          console.error('Error deleting comment:', deleteError)
          // Content might already be deleted, continue
        }
        actionTaken = 'content_deleted'
      }
    } else {
      actionTaken = 'dismissed'
    }
    
    // Update the report
    const { error: updateError } = await supabase
      .from('content_reports')
      .update({
        status: action === 'resolve' ? 'resolved' : 'dismissed',
        resolved_by: admin.id,
        resolved_at: new Date().toISOString(),
        action_taken: actionTaken + (reason ? `: ${reason}` : ''),
      })
      .eq('id', reportId)
    
    if (updateError) {
      console.error('Error updating report:', updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }
    
    // Log the action
    await supabase.from('admin_logs').insert({
      admin_id: admin.id,
      action: action === 'resolve' ? 'resolve_report' : 'dismiss_report',
      target_type: 'report',
      target_id: reportId,
      details: {
        content_type: report.content_type,
        content_id: report.content_id,
        action_taken: actionTaken,
        reason,
      },
    })
    
    return NextResponse.json({
      ok: true,
      message: action === 'resolve' ? 'Report resolved and content deleted' : 'Report dismissed',
    })
  } catch (error: any) {
    console.error('Resolve report API error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
