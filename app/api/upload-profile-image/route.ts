/**
 * Profile Image Upload API
 * Handles avatar and cover image uploads using service role to bypass RLS
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'
import logger from '@/lib/logger'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const formData = await request.formData()
    const file = formData.get('file') as File
    const userId = formData.get('userId') as string
    const bucket = formData.get('bucket') as string // 'avatars' or 'covers'

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!userId) {
      return NextResponse.json({ error: 'No userId provided' }, { status: 401 })
    }

    // Verify the userId matches the session user
    if (user.id !== userId) {
      return NextResponse.json({ error: 'Cannot upload images for another user' }, { status: 403 })
    }

    if (!bucket || !['avatars', 'covers'].includes(bucket)) {
      return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
    }

    // Validate file size FIRST so we don't load a huge attacker file into memory
    const maxSize = bucket === 'avatars' ? 5 * 1024 * 1024 : 10 * 1024 * 1024
    if (file.size > maxSize) {
      return NextResponse.json({
        error: `File size cannot exceed ${maxSize / 1024 / 1024}MB`,
        code: 'FILE_TOO_LARGE'
      }, { status: 400 })
    }

    // SECURITY (audit P1-SEC-2 follow-up): magic-byte sniff.
    // file.type and file.name are client-controlled and trivially spoofable.
    const sniffed = await sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])
    if (!sniffed) {
      return NextResponse.json({
        error: 'Only JPG, PNG, GIF, WebP, AVIF formats are supported',
        code: 'INVALID_FILE_TYPE'
      }, { status: 400 })
    }

    // Generate unique filename — use SERVER-derived extension from sniffed magic bytes
    const fileName = `${userId}-${Date.now()}.${sniffed.extension}`

    // Upload file with SNIFFED Content-Type, not client-supplied
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, file, {
        contentType: sniffed.mime,
        upsert: true
      })

    if (uploadError) {
      logger.error(`[upload-profile-image] ${bucket} upload error:`, uploadError)

      if (uploadError.message?.includes('Bucket not found')) {
        return NextResponse.json({
          error: 'Storage bucket not configured, please contact administrator',
          code: 'BUCKET_NOT_FOUND'
        }, { status: 503 })
      }

      return NextResponse.json({
        error: uploadError.message
      }, { status: 500 })
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(fileName)

    return NextResponse.json({
      url: urlData.publicUrl,
      fileName
    })
  },
  { name: 'upload-profile-image', rateLimit: 'sensitive' }
)
