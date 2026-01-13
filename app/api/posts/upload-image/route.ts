import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File
    const userId = formData.get('userId') as string

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 })
    }

    if (!userId) {
      return NextResponse.json({ error: 'No userId provided' }, { status: 401 })
    }

    // 验证文件类型
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type. Only jpg, png, gif, webp are allowed.' }, { status: 400 })
    }

    // 验证文件大小 (5MB)
    const maxSize = 5 * 1024 * 1024 // 5MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: 'File too large. Maximum size is 5MB.' }, { status: 400 })
    }

    // 创建 Supabase 客户端（使用 service key 以绕过 RLS）
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 生成唯一文件名
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(2, 15)
    const fileExt = file.name.split('.').pop()
    const fileName = `${userId}/${timestamp}-${randomStr}.${fileExt}`

    // 上传到 Supabase Storage
    const { data, error } = await supabase.storage
      .from('posts')
      .upload(fileName, file, {
        contentType: file.type,
        upsert: false,
      })

    if (error) {
      console.error('Upload error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // 获取公共 URL
    const { data: urlData } = supabase.storage
      .from('posts')
      .getPublicUrl(fileName)

    return NextResponse.json({
      url: urlData.publicUrl,
      fileName: data.path,
    })
  } catch (error: any) {
    console.error('Error uploading image:', error)
    return NextResponse.json({ error: error.message || 'Upload failed' }, { status: 500 })
  }
}

