import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// Supported file types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'application/zip',
  'application/x-rar-compressed',
]

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const formData = await request.formData()
    const file = formData.get('file') as File
    const userId = formData.get('userId') as string
    const conversationId = formData.get('conversationId') as string

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!userId) {
      return NextResponse.json({ error: 'No userId provided' }, { status: 401 })
    }

    if (!conversationId) {
      return NextResponse.json({ error: 'No conversationId provided' }, { status: 400 })
    }

    // Determine file category
    let fileCategory: 'image' | 'video' | 'file'
    let maxSize: number

    if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
      fileCategory = 'image'
      maxSize = MAX_IMAGE_SIZE
    } else if (ALLOWED_VIDEO_TYPES.includes(file.type)) {
      fileCategory = 'video'
      maxSize = MAX_VIDEO_SIZE
    } else if (ALLOWED_FILE_TYPES.includes(file.type)) {
      fileCategory = 'file'
      maxSize = MAX_FILE_SIZE
    } else {
      return NextResponse.json({
        error: '不支持的文件类型',
        allowedTypes: {
          images: ['jpg', 'png', 'gif', 'webp'],
          videos: ['mp4', 'webm', 'mov'],
          files: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'rar'],
        },
      }, { status: 400 })
    }

    // Validate file size
    if (file.size > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024))
      return NextResponse.json({
        error: `文件太大，最大允许 ${maxSizeMB}MB`,
      }, { status: 400 })
    }

    // Create Supabase client with service key
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Check if chat bucket exists, create if not
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets()
    if (bucketsError) {
      console.error('Error listing buckets:', bucketsError)
      return NextResponse.json({
        error: 'Storage service unavailable',
        details: bucketsError.message,
      }, { status: 503 })
    }

    const chatBucketExists = buckets?.some(b => b.id === 'chat')
    if (!chatBucketExists) {
      // Create chat bucket
      const { error: createBucketError } = await supabase.storage.createBucket('chat', {
        public: true,
        fileSizeLimit: MAX_VIDEO_SIZE,
      })
      if (createBucketError && !createBucketError.message?.includes('already exists')) {
        console.error('Error creating chat bucket:', createBucketError)
        return NextResponse.json({
          error: 'Could not create storage bucket',
        }, { status: 503 })
      }
    }

    // Generate unique filename
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 15)
    const fileExt = file.name.split('.').pop()?.toLowerCase() || 'bin'
    const safeOriginalName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50)
    const fileName = `${conversationId}/${fileCategory}/${timestamp}-${randomStr}-${safeOriginalName}`

    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from('chat')
      .upload(fileName, file, {
        contentType: file.type,
        upsert: false,
      })

    if (error) {
      console.error('Upload error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from('chat')
      .getPublicUrl(fileName)

    return NextResponse.json({
      url: urlData.publicUrl,
      fileName: data.path,
      originalName: file.name,
      fileType: file.type,
      fileSize: file.size,
      category: fileCategory,
    })
  } catch (error: unknown) {
    console.error('Error uploading chat file:', error)
    const errorMessage = error instanceof Error ? error.message : 'Upload failed'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
}
