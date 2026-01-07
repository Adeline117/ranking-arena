'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import TopNav from '@/app/components/Layout/TopNav'
import { Box, Text, Button } from '@/app/components/Base'
import { tokens } from '@/lib/design-tokens'

export default function NewPostPage() {
  const params = useParams<{ handle: string }>()
  const handle = params.handle as string
  const router = useRouter()

  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)
    })
  }, [])

  const handleSubmit = async () => {
    if (!title.trim()) {
      alert('请输入标题')
      return
    }

    if (!userId) {
      alert('请先登录')
      router.push('/login')
      return
    }

    // 获取用户的handle
    const { data: profile } = await supabase
      .from('profiles')
      .select('handle')
      .eq('id', userId)
      .maybeSingle()

    if (!profile || profile.handle !== handle) {
      alert('无权发布')
      return
    }

    setLoading(true)
    try {
      const { error } = await supabase.from('posts').insert({
        title,
        content,
        author_handle: handle,
        // group_id 为 null，表示这是个人动态
      })

      if (error) {
        alert(error.message)
        return
      }

      router.push(`/u/${handle}`)
    } catch (error: any) {
      alert(error?.message || '发布失败')
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
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              标题
            </Text>
            <input
              type="text"
              placeholder="输入标题..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{
                width: '100%',
                padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                outline: 'none',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            />
          </Box>

          <Box>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], display: 'block' }}>
              内容
            </Text>
            <textarea
              placeholder="输入内容..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              style={{
                width: '100%',
                padding: tokens.spacing[4],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.secondary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.base,
                outline: 'none',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                resize: 'vertical',
                lineHeight: 1.6,
              }}
            />
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



