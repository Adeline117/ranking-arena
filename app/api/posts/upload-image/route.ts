import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { sniffImageFile } from '@/lib/utils/image-magic-bytes'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const userId = user.id

    const formData = await request.formData()
    const file = formData.get('file') as File

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    // 验证文件大小 (5MB) — check size BEFORE sniffing so we don't load
    // a 100MB attacker payload into memory just to read its magic bytes.
    const maxSize = 5 * 1024 * 1024 // 5MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'File too large. Maximum size is 5MB.' }, { status: 400 })
    }

    // SECURITY (audit P1-SEC-2): sniff magic bytes — DO NOT trust client
    // file.type or file.name extension. A malicious uploader can send
    // file.type='image/jpeg' with PHP/HTML/SVG content and the bucket would
    // serve it back as the claimed type, enabling stored XSS or hosted
    // phishing on our origin. We override storage Content-Type with the
    // sniffed value below to make sure the bucket honors our verdict, not
    // the client's claim.
    const sniffed = await sniffImageFile(file, ['jpeg', 'png', 'gif', 'webp', 'avif'])
    if (!sniffed) {
      return NextResponse.json(
        { error: 'Invalid file type. Only jpg, png, gif, webp, avif images are allowed.' },
        { status: 400 },
      )
    }

    // 检查 posts bucket 是否存在
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets()
    if (bucketsError) {
      logger.error('Error listing buckets:', bucketsError)
      return NextResponse.json({
        error: 'Storage service unavailable. Please contact administrator.',
      }, { status: 503 })
    }

    const postsBucketExists = buckets?.some((b: { id: string }) => b.id === 'posts')
    if (!postsBucketExists) {
      logger.error('Posts bucket does not exist. Please run scripts/setup_posts_storage.sql')
      return NextResponse.json({
        error: 'Storage not configured. Please contact administrator to run setup_posts_storage.sql',
        code: 'BUCKET_NOT_FOUND'
      }, { status: 503 })
    }

    // 生成唯一文件名 — use SERVER-derived extension from sniffed magic
    // bytes, NOT the client-supplied filename. Prevents .php / .html /
    // .svg uploads that pass the type check via spoofed file.type.
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 15)
    const fileName = `${userId}/${timestamp}-${randomStr}.${sniffed.extension}`

    // 上传到 Supabase Storage with SNIFFED Content-Type, not client-supplied.
    const { data, error } = await supabase.storage
      .from('posts')
      .upload(fileName, file, {
        contentType: sniffed.mime,
        upsert: false,
      })

    if (error) {
      logger.error('Upload error:', error)
      // 提供更详细的错误信息
      if (error.message?.includes('Bucket not found')) {
        return NextResponse.json({
          error: 'Storage bucket not configured. Please run setup_posts_storage.sql',
          code: 'BUCKET_NOT_FOUND'
        }, { status: 503 })
      }
      if (error.message?.includes('security') || error.message?.includes('policy')) {
        return NextResponse.json({
          error: 'Upload permission denied. Please check storage policies.',
          code: 'PERMISSION_DENIED'
        }, { status: 403 })
      }
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    // 验证文件确实上传成功 - 检查文件是否存在
    const { data: fileList, error: listError } = await supabase.storage
      .from('posts')
      .list(userId, {
        search: `${timestamp}-${randomStr}`,
        limit: 1,
      })

    if (listError || !fileList || fileList.length === 0) {
      logger.error('Upload verification failed - file not found after upload:', listError)
      return NextResponse.json({
        error: 'Upload verification failed. File may not have been saved correctly.',
        code: 'VERIFICATION_FAILED'
      }, { status: 500 })
    }

    // 获取公共 URL
    const { data: urlData } = supabase.storage
      .from('posts')
      .getPublicUrl(fileName)

    // 验证 URL 是否可访问（可选的额外验证）
    const publicUrl = urlData.publicUrl

    return NextResponse.json({
      url: publicUrl,
      fileName: data.path,
      verified: true, // 标记已验证
    })
  },
  { name: 'posts/upload-image', rateLimit: 'write' }
)
