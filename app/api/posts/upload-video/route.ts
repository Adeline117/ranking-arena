import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthUser } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 支持的视频格式
const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime', // .mov
  'video/x-msvideo', // .avi
  'video/x-matroska', // .mkv
]

// 最大文件大小: 100MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    // Authenticate from JWT, not from client-submitted formData
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: '请先登录' }, { status: 401 })
    }
    const userId = user.id

    const formData = await request.formData()
    const file = formData.get('file') as File

    if (!file) {
      return NextResponse.json({ error: '未提供视频文件' }, { status: 400 })
    }

    // 验证文件类型
    if (!ALLOWED_VIDEO_TYPES.includes(file.type)) {
      return NextResponse.json(
        {
          error: '不支持的视频格式。支持的格式: MP4, WebM, MOV, AVI, MKV',
          supportedFormats: ['MP4', 'WebM', 'MOV', 'AVI', 'MKV']
        },
        { status: 400 }
      )
    }

    // 验证文件大小
    if (file.size > MAX_VIDEO_SIZE) {
      return NextResponse.json(
        {
          error: `视频文件过大。最大允许 ${MAX_VIDEO_SIZE / 1024 / 1024}MB`,
          maxSize: MAX_VIDEO_SIZE,
          currentSize: file.size
        },
        { status: 400 }
      )
    }

    // 创建 Supabase 客户端（使用 service key 以绕过 RLS）
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 生成唯一文件名
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 15)
    const fileExt = file.name.split('.').pop()?.toLowerCase() || 'mp4'
    const fileName = `${userId}/videos/${timestamp}-${randomStr}.${fileExt}`

    // 上传到 Supabase Storage
    const { data, error } = await supabase.storage
      .from('posts')
      .upload(fileName, file, {
        contentType: file.type,
        upsert: false,
      })

    if (error) {
      console.error('Video upload error:', error)
      return NextResponse.json({ error: "Internal server error" }, { status: 500 })
    }

    // 获取公共 URL
    const { data: urlData } = supabase.storage
      .from('posts')
      .getPublicUrl(fileName)

    return NextResponse.json({
      url: urlData.publicUrl,
      fileName: data.path,
      fileSize: file.size,
      fileType: file.type,
    })
  } catch (error: unknown) {
    console.error('Error uploading video:', error)
    const errorMessage = error instanceof Error ? error.message : '视频上传失败'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
