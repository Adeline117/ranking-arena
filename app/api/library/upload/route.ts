/**
 * POST /api/library/upload
 *
 * Upload a PDF/ebook to R2 storage for a library item.
 * Requires admin authentication (service role or admin user).
 *
 * Body: multipart/form-data with:
 *   - file: the PDF/ebook file
 *   - itemId: the library_items.id to associate with
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { isR2Configured, uploadFile, libraryPdfKey } from '@/lib/r2'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const ALLOWED_TYPES = [
  'application/pdf',
  'application/epub+zip',
  'application/x-mobipocket-ebook',
]

const MAX_SIZE = 100 * 1024 * 1024 // 100 MB

export async function POST(req: NextRequest) {
  const rateLimitResp = await checkRateLimit(req, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    // Check R2 is configured
    if (!isR2Configured()) {
      return NextResponse.json(
        { error: 'R2 storage is not configured' },
        { status: 503 }
      )
    }

    // Auth: require dedicated admin secret (never expose service role key in headers)
    const authHeader = req.headers.get('authorization')
    const expectedKey = process.env.ADMIN_SECRET || process.env.CRON_SECRET
    if (!authHeader || !expectedKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    // Use constant-time comparison to prevent timing attacks
    const { timingSafeEqual } = await import('crypto')
    const a = Buffer.from(authHeader)
    const b = Buffer.from(`Bearer ${expectedKey}`)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await req.formData()
    const file = formData.get('file') as File | null
    const itemId = formData.get('itemId') as string | null

    if (!file || !itemId) {
      return NextResponse.json(
        { error: 'Missing file or itemId' },
        { status: 400 }
      )
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB)` },
        { status: 400 }
      )
    }

    const contentType = file.type || 'application/pdf'
    if (!ALLOWED_TYPES.includes(contentType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${contentType}` },
        { status: 400 }
      )
    }

    // Verify item exists
    const supabase = getSupabaseAdmin()
    const { data: item, error: itemErr } = await supabase
      .from('library_items')
      .select('id, title')
      .eq('id', itemId)
      .single()

    if (itemErr || !item) {
      return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    }

    // Upload to R2
    const buffer = Buffer.from(await file.arrayBuffer())
    const key = libraryPdfKey(itemId, file.name)
    const { url } = await uploadFile(key, buffer, contentType)

    // Update DB with R2 URL
    const { error: updateErr } = await supabase
      .from('library_items')
      .update({
        r2_pdf_url: url,
        r2_pdf_key: key,
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)

    if (updateErr) {
      logger.error('Failed to update library item:', updateErr)
      return NextResponse.json(
        { error: 'Upload succeeded but DB update failed', url },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, url, key })
  } catch (e: unknown) {
    logger.error('Upload error:', e)
    return NextResponse.json(
      { error: (e instanceof Error ? e.message : 'Internal server error') },
      { status: 500 }
    )
  }
}
