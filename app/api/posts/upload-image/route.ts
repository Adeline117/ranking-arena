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
    const fileEntry = formData.get('file')

    if (!fileEntry || typeof fileEntry === 'string') {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }
    const file = fileEntry

    // 验证文件大小 (5MB) — check size BEFORE sniffing so we don't load
    // a 100MB attacker payload into memory just to read its magic bytes.
    const maxSize = 5 * 1024 * 1024 // 5MB
    if (file.size <= 0) {
      return NextResponse.json({ error: 'File is empty' }, { status: 400 })
    }
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
        { status: 400 }
      )
    }

    // 生成唯一文件名 — use SERVER-derived extension from sniffed magic
    // bytes, NOT the client-supplied filename. Prevents .php / .html /
    // .svg uploads that pass the type check via spoofed file.type.
    const objectName = `${crypto.randomUUID()}.${sniffed.extension}`
    const fileName = `${userId}/${objectName}`

    // 上传到 Supabase Storage with SNIFFED Content-Type, not client-supplied.
    const { data, error } = await supabase.storage.from('posts').upload(fileName, file, {
      contentType: sniffed.mime,
      upsert: false,
    })

    if (error) {
      logger.error('Upload error:', error)
      // 提供更详细的错误信息
      if (error.message?.includes('Bucket not found')) {
        return NextResponse.json(
          {
            error: 'Post media storage is temporarily unavailable.',
            code: 'BUCKET_NOT_FOUND',
          },
          { status: 503 }
        )
      }
      if (error.message?.includes('security') || error.message?.includes('policy')) {
        return NextResponse.json(
          {
            error: 'Upload permission denied.',
            code: 'PERMISSION_DENIED',
          },
          { status: 403 }
        )
      }
      return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
    }

    // Treat the Storage acknowledgement as untrusted. Never continue with a
    // different object path and never delete a path returned by the server.
    if (!data || data.path !== fileName) {
      logger.error('Upload acknowledgement path mismatch', {
        expectedPath: fileName,
        acknowledgedPath: data?.path,
      })
      try {
        const { error: cleanupError } = await supabase.storage.from('posts').remove([fileName])
        if (cleanupError) logger.error('Failed to clean up unacknowledged upload:', cleanupError)
      } catch (cleanupError) {
        logger.error('Failed to clean up unacknowledged upload:', cleanupError)
      }
      return NextResponse.json({ error: 'Upload verification failed' }, { status: 500 })
    }

    // 验证文件确实上传成功 - 检查文件是否存在
    const { data: fileList, error: listError } = await supabase.storage.from('posts').list(userId, {
      search: objectName,
      limit: 1,
    })

    if (listError || !fileList?.some((storedFile) => storedFile.name === objectName)) {
      logger.error('Upload verification failed - file not found after upload:', listError)
      try {
        const { error: cleanupError } = await supabase.storage.from('posts').remove([fileName])
        if (cleanupError) logger.error('Failed to clean up unverifiable upload:', cleanupError)
      } catch (cleanupError) {
        logger.error('Failed to clean up unverifiable upload:', cleanupError)
      }
      return NextResponse.json(
        {
          error: 'Upload verification failed. File may not have been saved correctly.',
          code: 'VERIFICATION_FAILED',
        },
        { status: 500 }
      )
    }

    // 获取公共 URL
    const { data: urlData } = supabase.storage.from('posts').getPublicUrl(fileName)

    // 验证 URL 是否可访问（可选的额外验证）
    const publicUrl = urlData.publicUrl

    return NextResponse.json(
      {
        url: publicUrl,
        fileName: data.path,
        verified: true, // 标记已验证
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    )
  },
  { name: 'posts/upload-image', rateLimit: 'write' }
)
