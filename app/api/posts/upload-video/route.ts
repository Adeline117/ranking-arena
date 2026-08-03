import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { sniffVideoFile } from '@/lib/utils/video-magic-bytes'

// 最大文件大小: 100MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024

export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    // Authenticate from JWT, not from client-submitted formData
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Please log in first' }, { status: 401 })
    }
    const userId = user.id

    const formData = await request.formData()
    const fileEntry = formData.get('file')

    if (!fileEntry || typeof fileEntry === 'string') {
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 })
    }
    const file = fileEntry

    // 验证文件大小 (check first, before reading bytes)
    if (file.size <= 0) {
      return NextResponse.json({ error: 'Video file is empty' }, { status: 400 })
    }
    if (file.size > MAX_VIDEO_SIZE) {
      return NextResponse.json(
        {
          error: `Video file too large. Maximum ${MAX_VIDEO_SIZE / 1024 / 1024}MB`,
          maxSize: MAX_VIDEO_SIZE,
          currentSize: file.size,
        },
        { status: 400 }
      )
    }

    // Validate the bounded container header, including its subtype/DocType.
    const sniffed = await sniffVideoFile(file)

    if (!sniffed) {
      // Reject the file — magic bytes don't match any known video format
      return NextResponse.json(
        {
          error:
            'Unsupported video format. File content does not match any known video format. Supported formats: MP4, WebM, MOV, AVI, MKV',
          supportedFormats: ['MP4', 'WebM', 'MOV', 'AVI', 'MKV'],
        },
        { status: 400 }
      )
    }

    // Use sniffed content type and extension (no client-supplied fallback)
    const contentType = sniffed.mime
    const fileExt = sniffed.extension

    // 创建 Supabase 客户端（使用 service key 以绕过 RLS）
    const supabase = getSupabaseAdmin()

    // 生成唯一文件名
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 15)
    const fileName = `${userId}/videos/${timestamp}-${randomStr}.${fileExt}`

    // 上传到 Supabase Storage — use sniffed content type
    const { data, error } = await supabase.storage.from('posts').upload(fileName, file, {
      contentType,
      upsert: false,
    })

    if (error) {
      logger.error('Video upload error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // 获取公共 URL
    const { data: urlData } = supabase.storage.from('posts').getPublicUrl(fileName)

    return NextResponse.json({
      url: urlData.publicUrl,
      fileName: data.path,
      fileSize: file.size,
      fileType: contentType,
    })
  } catch (error: unknown) {
    logger.error('Error uploading video:', error)
    const _errorMessage = error instanceof Error ? error.message : 'Video upload failed'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
