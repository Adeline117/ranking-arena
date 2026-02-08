/**
 * Profile Image Upload API
 * Handles avatar and cover image uploads using service role to bypass RLS
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

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

    // Authenticate the request and verify the userId matches the session user
    const authUser = await getAuthUser(request)
    if (!authUser) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }
    if (authUser.id !== userId) {
      return NextResponse.json({ error: 'Cannot upload images for another user' }, { status: 403 })
    }

    if (!bucket || !['avatars', 'covers'].includes(bucket)) {
      return NextResponse.json({ error: 'Invalid bucket' }, { status: 400 })
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({
        error: 'Only JPG, PNG, GIF, WebP formats are supported',
        code: 'INVALID_FILE_TYPE'
      }, { status: 400 })
    }

    // Validate file size
    const maxSize = bucket === 'avatars' ? 5 * 1024 * 1024 : 10 * 1024 * 1024
    if (file.size > maxSize) {
      return NextResponse.json({
        error: `File size cannot exceed ${maxSize / 1024 / 1024}MB`,
        code: 'FILE_TOO_LARGE'
      }, { status: 400 })
    }

    // Create Supabase client with service role (bypasses RLS)
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false }
    })

    // Generate unique filename
    const fileExt = file.name.split('.').pop()?.toLowerCase() || 'jpg'
    const fileName = `${userId}-${Date.now()}.${fileExt}`

    // Upload file
    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(fileName, file, {
        contentType: file.type,
        upsert: true
      })

    if (uploadError) {
      console.error(`[upload-profile-image] ${bucket} upload error:`, uploadError)

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

  } catch (error: unknown) {
    console.error('[upload-profile-image] Error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Upload failed'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
