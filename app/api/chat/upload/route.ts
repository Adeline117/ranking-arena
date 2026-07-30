import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'
import logger from '@/lib/logger'
import { randomBytes } from 'node:crypto'
import {
  CHAT_MEDIA_BUCKET,
  CHAT_MEDIA_SIGNED_URL_TTL_SECONDS,
  parseChatMediaUrl,
} from '@/lib/chat/private-media'

// Supported file types
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime']
const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'audio/webm',
  'application/zip',
  'application/x-rar-compressed',
]

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return (
    value !== null &&
    typeof value !== 'string' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    Number.isSafeInteger(value.size) &&
    typeof value.arrayBuffer === 'function'
  )
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const formData = await request.formData()
    const fileEntry = formData.get('file')
    const scopeIdEntry = formData.get('conversationId')
    const scopeTypeEntry = formData.get('scopeType')

    if (!isUploadFile(fileEntry)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const file = fileEntry

    if (typeof scopeIdEntry !== 'string') {
      return NextResponse.json({ error: 'No conversationId provided' }, { status: 400 })
    }
    const scopeId = scopeIdEntry.toLowerCase()
    if (!UUID_PATTERN.test(scopeId)) {
      return NextResponse.json({ error: 'Invalid conversationId' }, { status: 400 })
    }

    // Missing scopeType remains a backwards-compatible direct-message request.
    const scopeType =
      scopeTypeEntry === null
        ? 'conversation'
        : typeof scopeTypeEntry === 'string'
          ? scopeTypeEntry
          : null
    if (scopeType !== 'conversation' && scopeType !== 'channel') {
      return NextResponse.json({ error: 'Invalid upload scope' }, { status: 400 })
    }

    if (scopeType === 'conversation') {
      const { data: conversation, error: conversationError } = await supabase
        .from('conversations')
        .select('user1_id, user2_id')
        .eq('id', scopeId)
        .maybeSingle()
      if (conversationError) {
        logger.error('Conversation upload authorization failed:', conversationError)
        return NextResponse.json({ error: 'Could not authorize upload' }, { status: 503 })
      }
      if (
        !conversation ||
        (conversation.user1_id !== user.id && conversation.user2_id !== user.id)
      ) {
        return NextResponse.json({ error: 'Not a member of this conversation' }, { status: 403 })
      }
    } else {
      const { data: channel, error: channelError } = await supabase
        .from('chat_channels')
        .select('id, type')
        .eq('id', scopeId)
        .maybeSingle()
      if (channelError) {
        logger.error('Channel upload authorization failed:', channelError)
        return NextResponse.json({ error: 'Could not authorize upload' }, { status: 503 })
      }

      const { data: membership, error: membershipError } = await supabase
        .from('channel_members')
        .select('channel_id')
        .eq('channel_id', scopeId)
        .eq('user_id', user.id)
        .maybeSingle()
      if (membershipError) {
        logger.error('Channel membership upload authorization failed:', membershipError)
        return NextResponse.json({ error: 'Could not authorize upload' }, { status: 503 })
      }
      if (!channel || channel.type !== 'group' || !membership) {
        return NextResponse.json({ error: 'Not a member of this channel' }, { status: 403 })
      }
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
      return NextResponse.json(
        {
          error: 'Unsupported file type',
          allowedTypes: {
            images: ['jpg', 'png', 'gif', 'webp'],
            videos: ['mp4', 'webm', 'mov'],
            files: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'zip', 'rar'],
          },
        },
        { status: 400 }
      )
    }

    // Validate file size
    if (file.size <= 0) {
      return NextResponse.json({ error: 'File is empty' }, { status: 400 })
    }

    if (file.size > maxSize) {
      const maxSizeMB = Math.round(maxSize / (1024 * 1024))
      return NextResponse.json(
        {
          error: `File too large, maximum ${maxSizeMB}MB`,
        },
        { status: 400 }
      )
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
        return NextResponse.json(
          {
            error:
              'Image content does not match a supported format. Try jpg, png, gif, webp, avif.',
          },
          { status: 400 }
        )
      }
      sniffedMime = sniffed.mime
      sniffedExt = sniffed.extension
    }

    // Deployments must provision the bucket privately. Never create or repair
    // it in a request, because a public fallback turns every attachment into a
    // bearerless permanent URL.
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets()
    if (bucketsError) {
      logger.error('Error listing buckets:', bucketsError)
      return NextResponse.json(
        {
          error: 'Storage service unavailable',
          details: bucketsError.message,
        },
        { status: 503 }
      )
    }

    const chatBucket = buckets?.find((bucket: { id: string }) => bucket.id === CHAT_MEDIA_BUCKET)
    if (!chatBucket || chatBucket.public !== false) {
      logger.error('Chat storage bucket is missing or public')
      return NextResponse.json({ error: 'Private chat storage is not configured' }, { status: 503 })
    }

    // Generate unique filename. For images, force SERVER-derived extension
    // from the sniffed magic bytes — never echo the client-supplied name
    // back to disk in a path that could be served as text/html or SVG.
    const timestamp = Date.now()
    const randomStr = randomBytes(12).toString('hex')
    const safeOriginalName =
      file.name.replace(/[^a-zA-Z0-9.-]/g, '_').substring(0, 50) || 'attachment'
    const fileName = sniffedExt
      ? `${scopeId}/${fileCategory}/${timestamp}-${randomStr}.${sniffedExt}`
      : `${scopeId}/${fileCategory}/${timestamp}-${randomStr}-${safeOriginalName}`

    // Upload to Supabase Storage with sniffed Content-Type for images,
    // declared type for video/file (out of scope for sniffing — see comment above)
    const storageBucket = supabase.storage.from(CHAT_MEDIA_BUCKET)
    const { data, error } = await storageBucket.upload(fileName, file, {
      contentType: sniffedMime || file.type,
      upsert: false,
    })

    if (error || data?.path !== fileName) {
      logger.error('Upload error:', error)
      if (!error) await storageBucket.remove([fileName]).catch(() => undefined)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const { data: signedData, error: signedError } = await storageBucket.createSignedUrl(
      fileName,
      CHAT_MEDIA_SIGNED_URL_TTL_SECONDS
    )
    if (
      signedError ||
      !signedData?.signedUrl ||
      parseChatMediaUrl(signedData.signedUrl, scopeId)?.objectName !== fileName
    ) {
      logger.error('Chat upload signing failed:', signedError)
      await storageBucket.remove([fileName]).catch(() => undefined)
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    return NextResponse.json({
      url: signedData.signedUrl,
      fileName: data.path,
      originalName: file.name,
      fileType: file.type,
      fileSize: file.size,
      category: fileCategory,
    })
  },
  { name: 'chat-upload', rateLimit: 'sensitive' }
)
