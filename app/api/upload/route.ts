/**
 * POST /api/upload
 *
 * Upload a file to Supabase Storage. Used by ReportModal for screenshot attachments.
 * Requires authentication. Max file size: 2MB.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, requireAuth, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { randomBytes } from 'crypto'
import logger from '@/lib/logger'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_BUCKETS = ['reports', 'avatars', 'posts']

export async function POST(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bucket = (formData.get('bucket') as string) || 'reports'

    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return NextResponse.json({ error: `Invalid bucket. Allowed: ${ALLOWED_BUCKETS.join(', ')}` }, { status: 400 })
    }

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 2MB)' }, { status: 400 })
    }

    // SECURITY (audit P1-SEC-2): sniff magic bytes — DO NOT trust client
    // file.type or file.name extension. See lib/utils/image-magic-bytes.ts.
    const sniffed = await sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])
    if (!sniffed) {
      return NextResponse.json(
        { error: 'Invalid file type. Allowed: JPEG, PNG, WebP, GIF, AVIF' },
        { status: 400 },
      )
    }

    const supabase = getSupabaseAdmin()
    // Use SERVER-derived extension from sniffed magic bytes (not client filename).
    const fileName = `${user.id}/${randomBytes(8).toString('hex')}.${sniffed.extension}`

    const buffer = Buffer.from(await file.arrayBuffer())

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, buffer, {
        // Use sniffed Content-Type, not client-supplied. Prevents MIME confusion attacks.
        contentType: sniffed.mime,
        upsert: false,
      })

    if (uploadError) {
      logger.error('[upload] Storage error:', uploadError)
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    const { data: publicUrl } = supabase.storage
      .from(bucket)
      .getPublicUrl(fileName)

    return NextResponse.json({ url: publicUrl.publicUrl })
  } catch (err: unknown) {
    logger.error('[upload] Error:', err)
    return NextResponse.json(
      { error: 'Upload failed' },
      { status: err instanceof Error && err.message.includes('Unauthorized') ? 401 : 500 }
    )
  }
}
