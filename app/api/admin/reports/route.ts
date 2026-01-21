/**
 * 内容举报管理 API
 * GET /api/admin/reports - 获取举报列表
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin, verifyAdmin } from '@/lib/admin/auth'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('admin-reports')

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const supabase = getSupabaseAdmin()
    const authHeader = req.headers.get('authorization')
    
    const admin = await verifyAdmin(supabase, authHeader)
    if (!admin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    
    const { searchParams } = new URL(req.url)
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')
    const status = searchParams.get('status') || 'pending' // pending, resolved, dismissed, all
    const contentType = searchParams.get('content_type') || 'all' // post, comment, all
    
    const offset = (page - 1) * limit
    
    let query = supabase
      .from('content_reports')
      .select('*', { count: 'exact' })
    
    // Apply status filter
    if (status !== 'all') {
      query = query.eq('status', status)
    }
    
    // Apply content type filter
    if (contentType !== 'all') {
      query = query.eq('content_type', contentType)
    }
    
    // Apply pagination and ordering
    const { data: reports, count, error } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)
    
    if (error) {
      logger.error('Error fetching reports', { error, page, limit, status, contentType })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    
    // Enrich reports with reporter info and content preview
    const enrichedReports = await Promise.all(
      (reports || []).map(async (report) => {
        // Get reporter info
        const { data: reporter } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .eq('id', report.reporter_id)
          .maybeSingle()
        
        // Get content preview
        let contentPreview = null
        let contentAuthor = null
        
        if (report.content_type === 'post') {
          const { data: post } = await supabase
            .from('posts')
            .select('id, title, content, author_id, author_handle')
            .eq('id', report.content_id)
            .maybeSingle()
          
          if (post) {
            contentPreview = {
              title: post.title,
              content: post.content?.slice(0, 200),
            }
            contentAuthor = {
              id: post.author_id,
              handle: post.author_handle,
            }
          }
        } else if (report.content_type === 'comment') {
          const { data: comment } = await supabase
            .from('comments')
            .select('id, content, author_id, author_handle')
            .eq('id', report.content_id)
            .maybeSingle()
          
          if (comment) {
            contentPreview = {
              content: comment.content?.slice(0, 200),
            }
            contentAuthor = {
              id: comment.author_id,
              handle: comment.author_handle,
            }
          }
        }
        
        return {
          ...report,
          reporter,
          contentPreview,
          contentAuthor,
        }
      })
    )
    
    return NextResponse.json({
      ok: true,
      reports: enrichedReports,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    logger.error('Reports API error', { error })
    const errorMessage = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
