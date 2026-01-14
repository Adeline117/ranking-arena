'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'
import { useToast } from '@/app/components/UI/Toast'
import { RankingSkeleton } from '@/app/components/UI/Skeleton'

interface UploadedImage {
  url: string
  fileName: string
}

const TITLE_MAX_LENGTH = 100
const CONTENT_MAX_LENGTH = 10000

// 链接解析函数
function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: '#8b6fa8',
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part}
        </a>
      )
    }
    return part
  })
}

export default function EditPostPage() {
  const params = useParams<{ id: string }>()
  const postId = params.id as string
  const router = useRouter()
  const { showToast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [images, setImages] = useState<UploadedImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [originalPost, setOriginalPost] = useState<any>(null)

  // 获取用户信息
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  // 加载帖子数据
  useEffect(() => {
    if (!postId || !userId) return

    const loadPost = async () => {
      setLoading(true)
      try {
        const { data: post, error } = await supabase
          .from('posts')
          .select('*')
          .eq('id', postId)
          .single()

        if (error) {
          console.error('Error loading post:', error)
          showToast('加载帖子失败', 'error')
          router.push('/my-posts')
          return
        }

        // 验证所有权
        if (post.author_id !== userId) {
          showToast('无权编辑此帖子', 'error')
          router.push('/my-posts')
          return
        }

        setOriginalPost(post)
        setTitle(post.title || '')
        setContent(post.content || '')
        // 兼容 images 和 image_urls 两种字段名
        const imageUrls = post.images || post.image_urls || []
        setImages(imageUrls.map((url: string) => ({ url, fileName: url.split('/').pop() || '' })))
      } catch (error) {
        console.error('Error loading post:', error)
        showToast('加载帖子失败', 'error')
      } finally {
        setLoading(false)
      }
    }

    loadPost()
  }, [postId, userId, router, showToast])

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
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp']
      if (!allowedTypes.includes(file.type)) {
        showToast(`${file.name} 格式不支持`, 'error')
        continue
      }

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

  // 提交更新
  const handleSubmit = async () => {
    if (!title.trim()) {
      showToast('请输入标题', 'warning')
      return
    }

    if (!userId || !originalPost) {
      showToast('无法保存', 'error')
      return
    }

    setSaving(true)
    try {
      // 如果有图片但没有插入到内容中，自动附加到内容末尾
      let finalContent = content
      if (images.length > 0) {
        const unincludedImages = images.filter(img => !content.includes(img.url))
        if (unincludedImages.length > 0) {
          finalContent += '\n\n' + unincludedImages.map(img => `![image](${img.url})`).join('\n')
        }
      }

      const { error } = await supabase
        .from('posts')
        .update({
          title,
          content: finalContent,
          images: images.map(img => img.url),
          updated_at: new Date().toISOString(),
        })
        .eq('id', postId)
        .eq('author_id', userId)

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast('更新成功！', 'success')
      router.push('/my-posts')
    } catch (error: any) {
      showToast(error?.message || '更新失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    )
  }

  if (!originalPost) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6], textAlign: 'center' }}>
          <Text size="lg" color="secondary">帖子不存在或无权编辑</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[2] }}>
          编辑帖子
        </Text>
        <Text size="sm" color="secondary" style={{ marginBottom: tokens.spacing[6] }}>
          修改你的帖子内容
        </Text>

        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
          {/* 标题 */}
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

          {/* 内容 */}
          <Box>
            <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[2] }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Text size="sm" weight="bold">
                  内容
                </Text>
                <Box style={{ display: 'flex', borderRadius: tokens.radius.md, overflow: 'hidden', border: `1px solid ${tokens.colors.border.primary}` }}>
                  <button
                    type="button"
                    onClick={() => setShowPreview(false)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                      border: 'none',
                      background: !showPreview ? '#8b6fa8' : 'transparent',
                      color: !showPreview ? '#fff' : tokens.colors.text.secondary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    ✏️ 编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPreview(true)}
                    style={{
                      padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                      border: 'none',
                      borderLeft: `1px solid ${tokens.colors.border.primary}`,
                      background: showPreview ? '#8b6fa8' : 'transparent',
                      color: showPreview ? '#fff' : tokens.colors.text.secondary,
                      fontSize: tokens.typography.fontSize.xs,
                      cursor: 'pointer',
                      fontWeight: 700,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    👁️ 预览
                  </button>
                </Box>
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
                  border: `2px solid #8b6fa8`,
                  background: `linear-gradient(135deg, rgba(139, 111, 168, 0.05) 0%, rgba(139, 111, 168, 0.1) 100%)`,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.base,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  position: 'relative',
                }}
              >
                {/* 预览模式标签 */}
                <Box
                  style={{
                    position: 'absolute',
                    top: -12,
                    left: 12,
                    background: '#8b6fa8',
                    color: '#fff',
                    padding: '2px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  预览模式
                </Box>
                {content ? renderContentWithLinks(content) : <Text color="tertiary">预览内容将显示在这里...</Text>}
              </Box>
            ) : (
              <textarea
                placeholder="输入内容... (链接会自动变为可点击)"
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
            />
            
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
              {images.map((img, index) => (
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
                    src={img.url}
                    alt={img.fileName}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <Box
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      display: 'flex',
                      gap: 4,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => insertImageToContent(img.url)}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        border: 'none',
                        background: 'rgba(0,0,0,0.6)',
                        color: '#fff',
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title="插入到内容"
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: '50%',
                        border: 'none',
                        background: 'rgba(255,0,0,0.6)',
                        color: '#fff',
                        fontSize: 12,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      title="删除图片"
                    >
                      ×
                    </button>
                  </Box>
                </Box>
              ))}
              
              {images.length < 9 && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: tokens.radius.md,
                    border: `2px dashed ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.tertiary,
                    fontSize: 32,
                    cursor: uploading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: uploading ? 0.5 : 1,
                  }}
                >
                  {uploading ? '...' : '+'}
                </button>
              )}
            </Box>
          </Box>

          {/* 操作按钮 */}
          <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing[3], marginTop: tokens.spacing[4] }}>
            <Button
              variant="secondary"
              onClick={() => router.push('/my-posts')}
              disabled={saving}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={saving || !title.trim()}
            >
              {saving ? '保存中...' : '保存更改'}
            </Button>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

