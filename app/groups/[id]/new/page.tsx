"use client"

import { useState, useEffect } from "react"
import { useParams, useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase/client"
import { tokens } from "@/lib/design-tokens"
import TopNav from "@/app/components/Layout/TopNav"
import { Box, Text, Button } from "@/app/components/Base"

export default function NewPostPage() {
  const params = useParams<{ id: string }>()
  const groupId = params.id as string
  const router = useRouter()

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [userHandle, setUserHandle] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [images, setImages] = useState<string[]>([])
  const [uploadingImages, setUploadingImages] = useState(false)
  const [links, setLinks] = useState<Array<{ url: string; title?: string; description?: string; image?: string }>>([])
  const [newLinkUrl, setNewLinkUrl] = useState("")
  const [addingLink, setAddingLink] = useState(false)
  const [poll, setPoll] = useState<{
    question: string
    options: string[]
    type: 'single' | 'multiple'
    endAt?: string
  } | null>(null)
  const [showPollForm, setShowPollForm] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
      
      if (!data.user) {
        router.push('/login')
        return
      }

      // 获取用户 handle
      loadUserHandle(data.user.id)
    })
  }, [router])

  const loadUserHandle = async (uid: string) => {
    try {
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', uid)
        .maybeSingle()
      
      if (userProfile?.handle) {
        setUserHandle(userProfile.handle)
        return
      }

      // 如果没有 handle，使用邮箱前缀
      const { data: user } = await supabase.auth.getUser()
      if (user?.user?.email) {
        setUserHandle(user.user.email.split('@')[0])
      }
    } catch (error) {
      console.error('Error loading user handle:', error)
    }
  }

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploadingImages(true)
    try {
      const uploadPromises = Array.from(files).map(async (file) => {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('userId', userId!)

        const response = await fetch('/api/posts/upload-image', {
          method: 'POST',
          body: formData,
        })

        if (!response.ok) {
          const error = await response.json()
          throw new Error(error.error || 'Upload failed')
        }

        const data = await response.json()
        return data.url
      })

      const uploadedUrls = await Promise.all(uploadPromises)
      setImages([...images, ...uploadedUrls])
    } catch (err: any) {
      alert('图片上传失败: ' + err.message)
    } finally {
      setUploadingImages(false)
      // 重置 input
      e.target.value = ''
    }
  }

  const removeImage = (index: number) => {
    setImages(images.filter((_, i) => i !== index))
  }

  const handleAddLink = async () => {
    if (!newLinkUrl.trim()) return

    setAddingLink(true)
    try {
      // 获取链接预览
      const response = await fetch(`/api/posts/link-preview?url=${encodeURIComponent(newLinkUrl)}`)
      const preview = response.ok ? await response.json() : null

      setLinks([
        ...links,
        {
          url: newLinkUrl,
          title: preview?.title,
          description: preview?.description,
          image: preview?.image,
        },
      ])
      setNewLinkUrl("")
    } catch (err) {
      // 即使预览失败，也添加链接
      setLinks([...links, { url: newLinkUrl }])
      setNewLinkUrl("")
    } finally {
      setAddingLink(false)
    }
  }

  const removeLink = (index: number) => {
    setLinks(links.filter((_, i) => i !== index))
  }

  const addPollOption = () => {
    if (!poll) return
    setPoll({ ...poll, options: [...poll.options, ''] })
  }

  const updatePollOption = (index: number, value: string) => {
    if (!poll) return
    const newOptions = [...poll.options]
    newOptions[index] = value
    setPoll({ ...poll, options: newOptions })
  }

  const removePollOption = (index: number) => {
    if (!poll || poll.options.length <= 2) return
    setPoll({ ...poll, options: poll.options.filter((_, i) => i !== index) })
  }

  const handlePublish = async () => {
    if (!userId) {
      alert('请先登录')
      router.push('/login')
      return
    }

    if (!title.trim() || !content.trim()) {
      alert('请填写标题和内容')
      return
    }

    if (poll && (!poll.question.trim() || poll.options.filter(o => o.trim()).length < 2)) {
      alert('请完善投票信息（至少2个选项）')
      return
    }

    setLoading(true)
    try {
      let pollId: string | null = null

      // 创建投票（如果有）
      if (poll && poll.question.trim() && poll.options.filter(o => o.trim()).length >= 2) {
        const pollOptions = poll.options
          .filter(o => o.trim())
          .map((text, index) => ({ text: text.trim(), votes: 0, index }))

        const { data: pollData, error: pollError } = await supabase
          .from('polls')
          .insert({
            question: poll.question.trim(),
            options: pollOptions,
            type: poll.type,
            end_at: poll.endAt || null,
          })
          .select()
          .single()

        if (pollError) {
          throw new Error('创建投票失败: ' + pollError.message)
        }

        pollId = pollData.id
      }

      // 创建帖子
      const { error } = await supabase.from("posts").insert({
        group_id: groupId,
        title: title.trim(),
        content: content.trim(),
        author_handle: userHandle || email?.split('@')[0] || 'anonymous',
        author_id: userId,
        images: images.length > 0 ? images : null,
        links: links.length > 0 ? links : null,
        poll_id: pollId,
      })

      if (error) {
        console.error('Error creating post:', error)
        alert(error.message || '发布失败，请重试')
        return
      }

      router.push(`/groups/${groupId}`)
    } catch (err: any) {
      console.error('Error:', err)
      alert(err?.message || '发布失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  if (!userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Text size="lg">加载中...</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      
      <Box style={{ maxWidth: 800, margin: '0 auto', padding: tokens.spacing[6] }}>
        <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[6] }}>
          发布新帖子
        </Text>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[4] }}
        >
          <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[2] }}>
            小组 ID: {groupId}
          </Text>
        </Box>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[4] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            标题
          </Text>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="输入帖子标题"
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
            }}
          />
        </Box>

        <Box
          bg="secondary"
          p={6}
          radius="xl"
          border="primary"
          style={{ marginBottom: tokens.spacing[4] }}
        >
          <Text size="lg" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            内容
          </Text>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="写下你的想法..."
            rows={12}
            style={{
              width: '100%',
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              outline: 'none',
              resize: 'vertical',
            }}
          />
          
          {/* 功能工具栏 */}
          <Box style={{ 
            display: 'flex', 
            gap: tokens.spacing[2], 
            marginTop: tokens.spacing[3],
            paddingTop: tokens.spacing[3],
            borderTop: `1px solid ${tokens.colors.border.primary}`,
          }}>
            {/* 图片按钮 */}
            <input
              type="file"
              accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
              multiple
              onChange={handleImageUpload}
              disabled={uploadingImages}
              style={{ display: 'none' }}
              id="image-upload"
            />
            <label htmlFor="image-upload" style={{ cursor: uploadingImages ? 'not-allowed' : 'pointer' }}>
              <Box
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${images.length > 0 ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.border.primary}`,
                  background: images.length > 0 ? 'rgba(139, 111, 168, 0.1)' : 'transparent',
                  color: images.length > 0 ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.text.secondary,
                  cursor: uploadingImages ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[1],
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {uploadingImages ? '⏳' : '📷'} 图片 {images.length > 0 && `(${images.length})`}
              </Box>
            </label>
            
            {/* 链接按钮 */}
            <Box
              onClick={() => {
                const linkSection = document.getElementById('link-section')
                if (linkSection) {
                  linkSection.style.display = linkSection.style.display === 'none' ? 'block' : 'none'
                }
              }}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${links.length > 0 ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.border.primary}`,
                background: links.length > 0 ? 'rgba(139, 111, 168, 0.1)' : 'transparent',
                color: links.length > 0 ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
                transition: `all ${tokens.transition.base}`,
              }}
            >
              🔗 链接 {links.length > 0 && `(${links.length})`}
            </Box>
            
            {/* 投票按钮 */}
            <Box
              onClick={() => {
                if (showPollForm) {
                  setPoll(null)
                  setShowPollForm(false)
                } else {
                  setPoll({
                    question: '',
                    options: ['', ''],
                    type: 'single',
                  })
                  setShowPollForm(true)
                }
              }}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${showPollForm ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.border.primary}`,
                background: showPollForm ? 'rgba(139, 111, 168, 0.1)' : 'transparent',
                color: showPollForm ? tokens.colors.accent?.primary || '#8b6fa8' : tokens.colors.text.secondary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.sm,
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
                transition: `all ${tokens.transition.base}`,
              }}
            >
              📊 投票
            </Box>
          </Box>

          {/* 已上传图片预览 */}
          {images.length > 0 && (
            <Box style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.spacing[3], marginTop: tokens.spacing[4] }}>
              {images.map((url, index) => (
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
                    src={url}
                    alt={`Upload ${index + 1}`}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                  <button
                    onClick={() => removeImage(index)}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      background: 'rgba(0,0,0,0.7)',
                      color: '#fff',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12px',
                    }}
                  >
                    ×
                  </button>
                </Box>
              ))}
            </Box>
          )}

          {/* 链接区域（可折叠） */}
          <Box id="link-section" style={{ display: links.length > 0 ? 'block' : 'none', marginTop: tokens.spacing[4] }}>
            <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
              <input
                type="url"
                value={newLinkUrl}
                onChange={(e) => setNewLinkUrl(e.target.value)}
                placeholder="输入链接 URL"
                style={{
                  flex: 1,
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.primary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                }}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    handleAddLink()
                  }
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAddLink}
                disabled={addingLink || !newLinkUrl.trim()}
              >
                {addingLink ? '...' : '添加'}
              </Button>
            </Box>
            {links.length > 0 && (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                {links.map((link, index) => (
                  <Box
                    key={index}
                    style={{
                      padding: tokens.spacing[2],
                      borderRadius: tokens.radius.md,
                      background: tokens.colors.bg.primary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      display: 'flex',
                      gap: tokens.spacing[2],
                      alignItems: 'center',
                    }}
                  >
                    <Text size="xs" color="tertiary" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {link.title || link.url}
                    </Text>
                    <button
                      onClick={() => removeLink(index)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: tokens.colors.text.tertiary,
                        cursor: 'pointer',
                        fontSize: '14px',
                        padding: tokens.spacing[1],
                      }}
                    >
                      ×
                    </button>
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          {/* 投票区域（可折叠） */}
          {showPollForm && poll && (
            <Box style={{ marginTop: tokens.spacing[4], padding: tokens.spacing[4], background: tokens.colors.bg.primary, borderRadius: tokens.radius.md, border: `1px solid ${tokens.colors.border.primary}` }}>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
                <Text size="sm" weight="semibold">投票设置</Text>
                <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                  <Button
                    variant={poll.type === 'single' ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setPoll({ ...poll, type: 'single' })}
                  >
                    单选
                  </Button>
                  <Button
                    variant={poll.type === 'multiple' ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setPoll({ ...poll, type: 'multiple' })}
                  >
                    多选
                  </Button>
                </Box>
              </Box>
              <input
                type="text"
                value={poll.question}
                onChange={(e) => setPoll({ ...poll, question: e.target.value })}
                placeholder="投票问题"
                style={{
                  width: '100%',
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: 'transparent',
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  outline: 'none',
                  marginBottom: tokens.spacing[2],
                }}
              />
              {poll.options.map((option, index) => (
                <Box key={index} style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
                  <input
                    type="text"
                    value={option}
                    onChange={(e) => updatePollOption(index, e.target.value)}
                    placeholder={`选项 ${index + 1}`}
                    style={{
                      flex: 1,
                      padding: tokens.spacing[2],
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: 'transparent',
                      color: tokens.colors.text.primary,
                      fontSize: tokens.typography.fontSize.sm,
                      outline: 'none',
                    }}
                  />
                  {poll.options.length > 2 && (
                    <button
                      onClick={() => removePollOption(index)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: '#ff7c7c',
                        cursor: 'pointer',
                        fontSize: '14px',
                      }}
                    >
                      ×
                    </button>
                  )}
                </Box>
              ))}
              <Button
                variant="text"
                size="sm"
                onClick={addPollOption}
                style={{ color: tokens.colors.accent?.primary || '#8b6fa8', padding: 0 }}
              >
                + 添加选项
              </Button>
            </Box>
          )}
        </Box>

        <Box style={{ display: 'flex', justifyContent: 'flex-end', gap: tokens.spacing[3] }}>
          <Button
            variant="secondary"
            onClick={() => router.back()}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handlePublish}
            disabled={loading || !title.trim() || !content.trim()}
          >
            {loading ? '发布中...' : '发布'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
