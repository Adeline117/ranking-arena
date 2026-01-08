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

    setLoading(true)
    try {
      const { error } = await supabase.from("posts").insert({
        group_id: groupId,
        title: title.trim(),
        content: content.trim(),
        author_handle: userHandle || email?.split('@')[0] || 'anonymous',
        author_id: userId, // 添加用户ID
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
