/**
 * 处理举报 API
 * POST /api/admin/reports/[id]/resolve
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-resolve-report')

export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Admin sensitive operation — failClose rate limiting
    const rateLimitResponse = await checkRateLimit(req, { ...RateLimitPresets.sensitive, prefix: 'admin-resolve', failClose: true })
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')

    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id: reportId } = await params
    let body: { action?: string; reason?: string }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 })
    }
    const { action, reason } = body

    // action: 'resolve' (delete content), 'dismiss' (ignore report)
    if (!action || !['resolve', 'dismiss'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
    
    // Get the report
    const { data: report, error: reportError } = await supabase
      .from('content_reports')
      .select('id, status, content_type, content_id')
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
          logger.warn('Error deleting post', { error: deleteError, postId: report.content_id })
          // Content might already be deleted, continue
        }
        actionTaken = 'content_deleted'
      } else if (report.content_type === 'comment') {
        const { error: deleteError } = await supabase
          .from('comments')
          .delete()
          .eq('id', report.content_id)
        
        if (deleteError) {
          logger.warn('Error deleting comment', { error: deleteError, commentId: report.content_id })
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
      logger.error('Error updating report', { error: updateError, reportId, action })
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
  } catch (error: unknown) {
    logger.error('Resolve report API error', { error })
    return NextResponse.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 })
  }
}
