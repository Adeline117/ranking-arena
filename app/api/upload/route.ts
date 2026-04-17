/**
 * POST /api/upload
 *
 * Upload a file to Supabase Storage. Used by ReportModal for screenshot attachments.
 * Requires authentication. Max file size: 2MB.
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { randomBytes } from 'crypto'
import { createLogger } from '@/lib/utils/logger'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'

const logger = createLogger('upload')

export const dynamic = 'force-dynamic'

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_BUCKETS = ['reports', 'avatars', 'posts']

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bucket = (formData.get('bucket') as string) || 'reports'

    if (!ALLOWED_BUCKETS.includes(bucket)) {
      return badRequest(`Invalid bucket. Allowed: ${ALLOWED_BUCKETS.join(', ')}`)
    }

    if (!file) {
      return badRequest('No file provided')
    }

    if (file.size > MAX_FILE_SIZE) {
      return badRequest('File too large (max 2MB)')
    }

    // SECURITY (audit P1-SEC-2): sniff magic bytes — DO NOT trust client
    // file.type or file.name extension. See lib/utils/image-magic-bytes.ts.
    const sniffed = await sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])
    if (!sniffed) {
      return badRequest('Invalid file type. Allowed: JPEG, PNG, WebP, GIF, AVIF')
    }

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
      return serverError('Upload failed')
    }

    const { data: publicUrl } = supabase.storage
      .from(bucket)
      .getPublicUrl(fileName)

    return NextResponse.json({ url: publicUrl.publicUrl })
  },
  {
    name: 'upload',
    rateLimit: 'sensitive',
  }
)
