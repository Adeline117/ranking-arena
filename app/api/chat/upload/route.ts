import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'
import logger from '@/lib/logger'

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

    // Security: Verify authentication
    const authUser = await getAuthUser(request)
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
    const file = formData.get('file') as File
    const _userId = authUser.id // Use authenticated user ID, ignore client-provided userId
    const conversationId = formData.get('conversationId') as string

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!conversationId) {
      return NextResponse.json({ error: 'No conversationId provided' }, { status: 400 })
    }

    // SECURITY: Verify user is a member of this conversation
    const supabaseCheck = getSupabaseAdmin()
    const { data: conv } = await supabaseCheck
      .from('conversations')
      .select('user1_id, user2_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv || (conv.user1_id !== authUser.id && conv.user2_id !== authUser.id)) {
      return NextResponse.json({ error: 'Not a member of this conversation' }, { status: 403 })
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
        error: 'Unsupported file type',
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
        error: `File too large, maximum ${maxSizeMB}MB`,
      }, { status: 400 })
    }

    // SECURITY (audit P1-SEC-2 follow-up): for the image category, sniff
    // magic bytes — file.type is client-controlled. SVG-as-image XSS is the
    // primary risk; PDFs/docs/zip from untrusted users are inherently
    // executable in many viewers but mitigating that requires opening them
    // in a sandbox which is out of scope here. Video files use container
    // formats that browsers don't execute scripts in.
    let sniffedMime: string | null = null
    let sniffedExt: string | null = null
    if (fileCategory === 'image') {
      const sniffed = await sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])
      if (!sniffed) {
        return NextResponse.json({
          error: 'Image content does not match a supported format. Try jpg, png, gif, webp, avif.',
        }, { status: 400 })
      }
      sniffedMime = sniffed.mime
      sniffedExt = sniffed.extension
    }

    // Create Supabase client with service key
    const supabase = getSupabaseAdmin()

    // Check if chat bucket exists, create if not
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets()
    if (bucketsError) {
      logger.error('Error listing buckets:', bucketsError)
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
        logger.error('Error creating chat bucket:', createBucketError)
        return NextResponse.json({
          error: 'Could not create storage bucket',
        }, { status: 503 })
      }
    }

    // Generate unique filename. For images, force SERVER-derived extension
    // from the sniffed magic bytes — never echo the client-supplied name
    // back to disk in a path that could be served as text/html or SVG.
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 15)
    const safeOriginalName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50)
    const fileName = sniffedExt
      ? `${conversationId}/${fileCategory}/${timestamp}-${randomStr}.${sniffedExt}`
      : `${conversationId}/${fileCategory}/${timestamp}-${randomStr}-${safeOriginalName}`

    // Upload to Supabase Storage with sniffed Content-Type for images,
    // declared type for video/file (out of scope for sniffing — see comment above)
    const { data, error } = await supabase.storage
      .from('chat')
      .upload(fileName, file, {
        contentType: sniffedMime || file.type,
        upsert: false,
      })

    if (error) {
      logger.error('Upload error:', error)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
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
    logger.error('Error uploading chat file:', error)
    const _errorMessage = error instanceof Error ? error.message : 'Upload failed'
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
