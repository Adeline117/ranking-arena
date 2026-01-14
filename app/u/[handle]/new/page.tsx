'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/UI/Toast'

interface UploadedImage {
  url: string
  fileName: string
}

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000
const DRAFT_KEY_PREFIX = 'post_draft_'

export default function NewPostPage() {
  const params = useParams<{ handle: string }>()
  const handle = params.handle as string
  const router = useRouter()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)

  const draftKey = `${DRAFT_KEY_PREFIX}${handle}`

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // Load draft from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && handle) {
      const draft = localStorage.getItem(draftKey)
      if (draft) {
        try {
          const { title: draftTitle, content: draftContent, images: draftImages } = JSON.parse(draft)
          if (draftTitle || draftContent) {
            setTitle(draftTitle || '')
            setContent(draftContent || '')
            setImages(draftImages || [])
            showToast('已恢复草稿', 'info')
          }
        } catch (e) {
          console.error('Failed to parse draft:', e)
        }
      }
    }
  }, [handle, draftKey])

  // Auto-save draft to localStorage (debounced)
  useEffect(() => {
    if (typeof window === 'undefined' || !handle) return
    
    const saveTimer = setTimeout(() => {
      if (title.trim() || content.trim()) {
        localStorage.setItem(draftKey, JSON.stringify({ title, content, images }))
        setDraftSaved(true)
        // Reset saved indicator after 2 seconds
        setTimeout(() => setDraftSaved(false), 2000)
      }
    }, 1000) // Save 1 second after user stops typing

    return () => clearTimeout(saveTimer)
  }, [title, content, images, handle, draftKey])

  // Clear draft after successful publish
  const clearDraft = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  // 处理图片上传
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    if (!userId) {
      showToast('请先登录', 'warning')
      return
    }

    if (images.length + files.length > 9) {
      showToast('最多上传9张图片', 'warning')
      return
    }

    setUploading(true)
    const newImages: UploadedImage[] = []

    for (const file of Array.from(files)) {
      // 验证文件类型
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
      if (!allowedTypes.includes(file.type)) {
        showToast(`${file.name} 格式不支持`, 'error')
        continue
      }

      // 验证文件大小 (5MB)
      if (file.size > 5 * 1024 * 1024) {
        showToast(`${file.name} 超过5MB`, 'error')
        continue
      }

      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('userId', userId)

        const response = await fetch('/api/posts/upload-image', {
          method: 'POST',
          body: formData,
        })

        const data = await response.json()

        if (!response.ok) {
          showToast(data.error || '上传失败', 'error')
          continue
        }

        newImages.push({
          url: data.url,
          fileName: data.fileName,
        })
      } catch (error) {
        console.error('Upload error:', error)
        showToast('上传失败', 'error')
      }
    }

    if (newImages.length > 0) {
      setImages(prev => [...prev, ...newImages])
      showToast(`成功上传 ${newImages.length} 张图片`, 'success')
    }

    setUploading(false)
    // 清空 file input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // 移除图片
  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
  }

  // 插入图片到内容
  const insertImageToContent = (url: string) => {
    const imageMarkdown = `\n![image](${url})\n`
    setContent(prev => prev + imageMarkdown)
    showToast('图片已插入到内容', 'info')
  }

  const handleSubmit = async () => {
    if (!title.trim()) {
      showToast('请输入标题', 'warning')
      return
    }

    if (!userId) {
      showToast('请先登录', 'warning')
      router.push('/login')
      return
    }

    // 获取用户的handle
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', userId)
      .maybeSingle()

    if (!profile || profile.handle !== handle) {
      showToast('无权发布', 'error')
      return
    }

    setLoading(true)
    try {
      // 如果有图片但没有插入到内容中，自动附加到内容末尾
      let finalContent = content
      if (images.length > 0) {
        const unincludedImages = images.filter(img => !content.includes(img.url))
        if (unincludedImages.length > 0) {
          finalContent += '\n\n' + unincludedImages.map(img => `![image](${img.url})`).join('\n')
        }
      }

      const { error } = await supabase.from('posts').insert({
        title,
        content: finalContent,
        author_handle: handle,
        // group_id 为 null，表示这是个人动态
        author_id: userId,
        image_urls: images.map(img => img.url),
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      // Clear draft after successful publish
      clearDraft()
      showToast('发布成功！', 'success')
      router.push(`/u/${handle}`)
    } catch (error: any) {
      showToast(error?.message || '发布失败', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          发动态
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          分享你的交易想法和见解
        </Text>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Text size="sm" weight="bold">
                标题
              </Text>
              <Text 
                size="xs" 
                style={{ color: title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
              >
                {title.length}/{TITLE_MAX_LENGTH}
              </Text>
            </Box>
            <input
              type="text"
              placeholder="输入标题..."
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX_LENGTH))}
              maxLength={TITLE_MAX_LENGTH}
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${title.length > TITLE_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                outline: 'none',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            />
          </Box>

          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Text size="sm" weight="bold">
                  内容
                </Text>
                <button
                  type="button"
                  onClick={() => setShowPreview(!showPreview)}
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.sm,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: showPreview ? tokens.colors.accent.primary : 'transparent',
                    color: showPreview ? '#fff' : tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.xs,
                    cursor: 'pointer',
                    fontWeight: 700,
                  }}
                >
                  {showPreview ? '编辑' : '预览'}
                </button>
                {draftSaved && (
                  <Text size="xs" color="tertiary" style={{ color: '#2fe57d' }}>
                    ✓ 草稿已保存
                  </Text>
                )}
              </Box>
              <Text 
                size="xs" 
                style={{ color: content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
              >
                {content.length}/{CONTENT_MAX_LENGTH}
              </Text>
            </Box>
            
            {showPreview ? (
              <Box
                style={{
                  width: '100%',
                  minHeight: 288,
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {content || <Text color="tertiary">预览内容将显示在这里...</Text>}
              </Box>
            ) : (
              <textarea
                placeholder="输入内容... (支持使用 @用户名 提及其他用户)"
                value={content}
                onChange={(e) => setContent(e.target.value.slice(0, CONTENT_MAX_LENGTH))}
                maxLength={CONTENT_MAX_LENGTH}
                rows={12}
                style={{
                  width: '100%',
                  padding: tokens.spacing[4],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${content.length > CONTENT_MAX_LENGTH ? tokens.colors.accent.error : tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  outline: 'none',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  resize: 'vertical',
                  lineHeight: 1.6,
                }}
              />
            )}
            <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
              提示：使用 @用户名 可以提及其他用户
            </Text>
          </Box>

          {/* 图片上传区域 */}
          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              图片（可选，最多9张）
            </Text>
            
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
              multiple
              onChange={handleImageUpload}
              style={{ display: 'none' }}
              id="image-upload"
            />
            
            <Box 
              style={{ 
                display: 'flex', 
                flexWrap: 'wrap', 
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
              }}
            >
              {/* 已上传的图片预览 */}
              {images.map((image, index) => (
                <Box
                  key={index}
                  style={{
                    position: 'relative',
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    overflow: 'hidden',
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <img
                    src={image.url}
                    alt={`Upload ${index + 1}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                  <Box
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      display: 'flex',
                      gap: 2,
                    }}
                  >
                    <button
                      onClick={() => insertImageToContent(image.url)}
                      title="插入到内容"
                      style={{
                        width: 24,
                        height: 24,
                        border: 'none',
                        background: 'rgba(139,111,168,0.9)',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 12,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ↵
                    </button>
                    <button
                      onClick={() => removeImage(index)}
                      title="删除"
                      style={{
                        width: 24,
                        height: 24,
                        border: 'none',
                        background: 'rgba(255,77,77,0.9)',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: 14,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      ×
                    </button>
                  </Box>
                </Box>
              ))}
              
              {/* 上传按钮 */}
              {images.length < 9 && (
                <label
                  htmlFor="image-upload"
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    border: `2px dashed ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    opacity: uploading ? 0.5 : 1,
                    transition: 'all 0.2s ease',
                  }}
                >
                  {uploading ? (
                    <Text size="xs" color="secondary">上传中...</Text>
                  ) : (
                    <>
                      <Text size="2xl" color="secondary" style={{ lineHeight: 1 }}>+</Text>
                      <Text size="xs" color="secondary">添加图片</Text>
                    </>
                  )}
                </label>
              )}
            </Box>
            
            <Text size="xs" color="tertiary">
              支持 JPG、PNG、GIF、WebP 格式，单张最大 5MB
            </Text>
          </Box>

          <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
            <Button
              variant="ghost"
              size="md"
              onClick={() => router.back()}
              disabled={loading}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={handleSubmit}
              disabled={loading || !title.trim()}
            >
              {loading ? '发布中...' : '发布'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}



