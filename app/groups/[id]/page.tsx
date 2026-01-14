'use client'

import Link from 'next/link'
import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/Layout/TopNav'
import Card from '@/app/components/UI/Card'
import { Box, Text, Button } from '@/app/components/Base'
import { useLanguage } from '@/app/components/Utils/LanguageProvider'
import { ThumbsUpIcon, ThumbsDownIcon, CommentIcon } from '@/app/components/Icons'

const ARENA_PURPLE = '#8b6fa8'

// 链接解析函数 - 将文本中的URL转换为可点击链接
function renderContentWithLinks(text: string) {
  if (!text) return null
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g
  const parts = text.split(urlRegex)
  
  return parts.map((part, index) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0 // Reset regex state
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: ARENA_PURPLE,
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

type Group = {
  id: string
  name: string
  name_en?: string | null
  description?: string | null
  description_en?: string | null
  avatar_url?: string | null
  member_count?: number | null
  created_at?: string | null
  created_by?: string | null
  rules?: string | null
  owner_handle?: string | null
}

type GroupMember = {
  user_id: string
  role: string
  handle?: string | null
  avatar_url?: string | null
  joined_at?: string | null
}

type Post = {
  id: string
  group_id: string
  title: string
  content?: string | null
  created_at: string
  author_handle?: string | null
  author_id?: string | null
  like_count?: number | null
  comment_count?: number | null
  bookmark_count?: number | null
  repost_count?: number | null
  user_liked?: boolean // 当前用户是否点赞
  user_bookmarked?: boolean // 当前用户是否收藏
  user_reposted?: boolean // 当前用户是否转发
}

export default function GroupDetailPage({ params }: { params: { id: string } | Promise<{ id: string }> }) {
  const [groupId, setGroupId] = useState<string>('')
  
  useEffect(() => {
    if (params && typeof params === 'object' && 'then' in params) {
      (params as Promise<{ id: string }>).then(resolved => {
        setGroupId(resolved.id)
      })
    } else {
      setGroupId(String((params as { id: string })?.id ?? ''))
    }
  }, [params])
  
  const { t, language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [group, setGroup] = useState<Group | null>(null)
  const [posts, setPosts] = useState<Post[]>([])
  const [sortedPosts, setSortedPosts] = useState<Post[]>([])
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const [sortMode, setSortMode] = useState<'latest' | 'hot'>('latest')
  const [likeLoading, setLikeLoading] = useState<Record<string, boolean>>({})
  const [bookmarkLoading, setBookmarkLoading] = useState<Record<string, boolean>>({})
  const [repostLoading, setRepostLoading] = useState<Record<string, boolean>>({})
  const [showRepostModal, setShowRepostModal] = useState<string | null>(null)
  const [repostComment, setRepostComment] = useState('')
  // 小组信息弹窗
  const [showGroupInfo, setShowGroupInfo] = useState(false)
  const [showMembersList, setShowMembersList] = useState(false)
  const [members, setMembers] = useState<GroupMember[]>([])
  const [loadingMembers, setLoadingMembers] = useState(false)
  // 评论相关状态
  const [expandedComments, setExpandedComments] = useState<Record<string, boolean>>({})
  const [comments, setComments] = useState<Record<string, any[]>>({})
  const [newComment, setNewComment] = useState<Record<string, string>>({})
  const [commentLoading, setCommentLoading] = useState<Record<string, boolean>>({})
  // 翻译相关状态
  const [translatedPosts, setTranslatedPosts] = useState<Record<string, { title?: string; content?: string }>>({})
  const [translatingPosts, setTranslatingPosts] = useState(false)
  // 展开/收起状态
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setEmail(data.session?.user?.email ?? null)
      setUserId(data.session?.user?.id ?? null)
      setAccessToken(data.session?.access_token ?? null)
    })
  }, [])

  // 获取用户点赞状态
  const fetchUserLikes = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    
    const { data } = await supabase
      .from('post_likes')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    
    const likeMap: Record<string, boolean> = {}
    data?.forEach(item => {
      likeMap[item.post_id] = true
    })
    return likeMap
  }, [])

  // 获取用户收藏状态
  const fetchUserBookmarks = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    
    const { data } = await supabase
      .from('post_bookmarks')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    
    const bookmarkMap: Record<string, boolean> = {}
    data?.forEach(item => {
      bookmarkMap[item.post_id] = true
    })
    return bookmarkMap
  }, [])

  // 获取用户转发状态
  const fetchUserReposts = useCallback(async (postIds: string[], uid: string) => {
    if (!uid || postIds.length === 0) return {}
    
    const { data } = await supabase
      .from('reposts')
      .select('post_id')
      .eq('user_id', uid)
      .in('post_id', postIds)
    
    const repostMap: Record<string, boolean> = {}
    data?.forEach(item => {
      repostMap[item.post_id] = true
    })
    return repostMap
  }, [])

  // 检测是否为中文文本
  const isChineseText = useCallback((text: string) => {
    if (!text) return false
    const chineseRegex = /[\u4e00-\u9fa5]/g
    const chineseMatches = text.match(chineseRegex)
    const chineseRatio = chineseMatches ? chineseMatches.length / text.length : 0
    return chineseRatio > 0.1
  }, [])

  // 翻译帖子
  const translatePosts = useCallback(async (postsToTranslate: Post[], targetLang: 'zh' | 'en') => {
    if (translatingPosts) return
    
    const needsTranslation = postsToTranslate.filter(p => {
      if (translatedPosts[p.id]?.title) return false
      const titleIsChinese = isChineseText(p.title || '')
      return targetLang === 'en' ? titleIsChinese : !titleIsChinese
    })
    
    if (needsTranslation.length === 0) return
    
    setTranslatingPosts(true)
    const batch = needsTranslation.slice(0, 5)
    
    for (const post of batch) {
      try {
        // 翻译标题
        const titleRes = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          cache: 'no-store',
          body: JSON.stringify({ text: post.title || '', targetLang }),
        })
        const titleData = await titleRes.json()
        
        // 翻译内容（如果有）
        let translatedContent = ''
        if (post.content) {
          const contentRes = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
            cache: 'no-store',
            body: JSON.stringify({ text: post.content, targetLang }),
          })
          const contentData = await contentRes.json()
          if (contentData.success) {
            translatedContent = contentData.data?.translatedText || ''
          }
        }
        
        if (titleData.success) {
          setTranslatedPosts(prev => ({
            ...prev,
            [post.id]: { 
              title: titleData.data?.translatedText || post.title,
              content: translatedContent || post.content || ''
            }
          }))
        }
      } catch (err) {
        console.error('[GroupPage] 翻译出错:', err)
      }
    }
    
    setTranslatingPosts(false)
  }, [translatingPosts, translatedPosts, isChineseText])

  // 当帖子加载或语言变化时触发翻译
  useEffect(() => {
    if (posts.length > 0) {
      translatePosts(posts, language as 'zh' | 'en')
    }
  }, [posts, language, translatePosts])

  useEffect(() => {
    // 等待 groupId 加载完成
    if (!groupId || groupId === 'loading') return

    const load = async () => {
      setLoading(true)
      setError(null)

      try {
        // 读取小组信息
        const { data: groupData, error: groupErr } = await supabase
          .from('groups')
          .select('id, name, name_en, description, description_en, avatar_url, member_count, created_at, created_by, rules')
          .eq('id', groupId)
          .maybeSingle()
        
        // 获取组长信息
        let ownerHandle = null
        if (groupData?.created_by) {
          const { data: ownerData } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', groupData.created_by)
            .maybeSingle()
          ownerHandle = ownerData?.handle
        }

        if (groupErr) {
          setError(groupErr.message)
          setLoading(false)
          return
        }

        setGroup(groupData ? { ...groupData, owner_handle: ownerHandle } as Group : null)

        // 读取帖子
        const { data: postsData, error: postsErr } = await supabase
          .from('posts')
          .select('id, group_id, title, content, created_at, author_handle, author_id, like_count, comment_count, bookmark_count, repost_count')
          .eq('group_id', groupId)
          .order('created_at', { ascending: false })
          .limit(50)

        if (postsErr) {
          setError(postsErr.message)
        } else {
          const postsList = (postsData || []) as Post[]
          
          // 获取用户点赞、收藏、转发状态
          if (userId) {
            const postIds = postsList.map(p => p.id)
            const [likeMap, bookmarkMap, repostMap] = await Promise.all([
              fetchUserLikes(postIds, userId),
              fetchUserBookmarks(postIds, userId),
              fetchUserReposts(postIds, userId)
            ])
            postsList.forEach(post => {
              post.user_liked = likeMap[post.id] || false
              post.user_bookmarked = bookmarkMap[post.id] || false
              post.user_reposted = repostMap[post.id] || false
            })
          }
          
          setPosts(postsList)
        }

        // 检查用户是否是成员
        if (userId) {
          const { data: membership } = await supabase
            .from('group_members')
            .select('*')
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .maybeSingle()
          setIsMember(!!membership)
        }
      } catch (err: any) {
        setError(err?.message || '加载失败')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [groupId, userId, fetchUserLikes, fetchUserBookmarks, fetchUserReposts])

  // 计算帖子排序
  useEffect(() => {
    if (posts.length === 0) {
      setSortedPosts([])
      return
    }

    if (sortMode === 'latest') {
      // 最新：按时间降序
      setSortedPosts([...posts].sort((a, b) => 
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ))
    } else {
      // 热门：按综合分数排序
      const now = Date.now()
      const sorted = [...posts].sort((a, b) => {
        const hoursA = (now - new Date(a.created_at).getTime()) / (1000 * 60 * 60)
        const hoursB = (now - new Date(b.created_at).getTime()) / (1000 * 60 * 60)
        
        const scoreA = ((a.like_count || 0) * 2 + (a.comment_count || 0) * 1) / (1 + hoursA / 24)
        const scoreB = ((b.like_count || 0) * 2 + (b.comment_count || 0) * 1) / (1 + hoursB / 24)
        
        return scoreB - scoreA
      })
      setSortedPosts(sorted)
    }
  }, [posts, sortMode])

  // 计算热度颜色 - 根据评论数从浅橙到深橙
  const getHeatColor = (commentCount: number, maxComments: number): string => {
    if (maxComments === 0) return '#FFE4CC' // 浅橙色
    const ratio = Math.min(commentCount / maxComments, 1)
    // 从 #FFE4CC (浅橙) 到 #FF6B00 (深橙)
    const r = Math.round(255)
    const g = Math.round(228 - ratio * (228 - 107))
    const b = Math.round(204 - ratio * 204)
    return `rgb(${r}, ${g}, ${b})`
  }

  // 计算最大评论数
  const maxComments = sortedPosts.reduce((max, post) => 
    Math.max(max, post.comment_count || 0), 0
  )

  // 点赞功能
  const handleLike = async (postId: string) => {
    if (!accessToken) {
      alert('请先登录')
      return
    }

    setLikeLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ reaction_type: 'up' }),
      })

      const result = await response.json()
      
      if (response.ok) {
        // 更新本地状态
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            const wasLiked = p.user_liked
            return {
              ...p,
              user_liked: !wasLiked,
              like_count: wasLiked 
                ? Math.max(0, (p.like_count || 0) - 1)
                : (p.like_count || 0) + 1,
            }
          }
          return p
        }))
      } else {
        alert(result.error || '操作失败')
      }
    } catch (err: any) {
      alert('网络错误: ' + err.message)
    } finally {
      setLikeLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 收藏功能
  const handleBookmark = async (postId: string) => {
    if (!accessToken) {
      alert(language === 'zh' ? '请先登录' : 'Please login first')
      return
    }

    setBookmarkLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/bookmark`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      })

      const result = await response.json()
      
      if (response.ok) {
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              user_bookmarked: result.bookmarked,
              bookmark_count: result.bookmark_count,
            }
          }
          return p
        }))
      } else {
        alert(result.error || (language === 'zh' ? '操作失败' : 'Operation failed'))
      }
    } catch (err: any) {
      alert((language === 'zh' ? '网络错误: ' : 'Network error: ') + err.message)
    } finally {
      setBookmarkLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 转发功能
  const handleRepost = async (postId: string, comment?: string) => {
    if (!accessToken) {
      alert(language === 'zh' ? '请先登录' : 'Please login first')
      return
    }

    // 检查是否是自己的帖子
    const post = posts.find(p => p.id === postId)
    if (post?.author_id === userId) {
      alert(language === 'zh' ? '不能转发自己的帖子' : 'Cannot repost your own post')
      return
    }

    if (post?.user_reposted) {
      alert(language === 'zh' ? '已经转发过此帖子' : 'Already reposted')
      return
    }

    setRepostLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/repost`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ comment }),
      })

      const result = await response.json()
      
      if (response.ok) {
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return {
              ...p,
              user_reposted: true,
              repost_count: result.repost_count,
            }
          }
          return p
        }))
        setShowRepostModal(null)
        setRepostComment('')
        alert(language === 'zh' ? '转发成功！' : 'Reposted successfully!')
      } else {
        alert(result.error || (language === 'zh' ? '转发失败' : 'Repost failed'))
      }
    } catch (err: any) {
      alert((language === 'zh' ? '网络错误: ' : 'Network error: ') + err.message)
    } finally {
      setRepostLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 加载成员列表
  const loadMembers = async () => {
    if (loadingMembers || !groupId) return
    
    setLoadingMembers(true)
    try {
      const { data: membersData } = await supabase
        .from('group_members')
        .select('user_id, role, joined_at')
        .eq('group_id', groupId)
        .order('role', { ascending: true }) // owner 在前
        .order('joined_at', { ascending: true })
      
      if (membersData && membersData.length > 0) {
        // 获取用户信息
        const userIds = membersData.map(m => m.user_id)
        const { data: profilesData } = await supabase
          .from('user_profiles')
          .select('id, handle, avatar_url')
          .in('id', userIds)
        
        const profileMap = new Map()
        profilesData?.forEach(p => {
          profileMap.set(p.id, { handle: p.handle, avatar_url: p.avatar_url })
        })
        
        // 排序：owner > admin > member
        const sortedMembers = membersData
          .map(m => ({
            ...m,
            handle: profileMap.get(m.user_id)?.handle,
            avatar_url: profileMap.get(m.user_id)?.avatar_url,
          }))
          .sort((a, b) => {
            const roleOrder: Record<string, number> = { owner: 0, admin: 1, member: 2 }
            return (roleOrder[a.role] || 2) - (roleOrder[b.role] || 2)
          })
        
        setMembers(sortedMembers)
      }
    } catch (err) {
      console.error('加载成员失败:', err)
    } finally {
      setLoadingMembers(false)
    }
  }

  // 加载评论
  const loadComments = async (postId: string) => {
    setCommentLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/comments`)
      const result = await response.json()
      
      if (response.ok) {
        setComments(prev => ({ ...prev, [postId]: result.comments || [] }))
      }
    } catch (err) {
      console.error('加载评论失败:', err)
    } finally {
      setCommentLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  // 展开/收起评论
  const toggleComments = (postId: string) => {
    const isExpanded = expandedComments[postId]
    setExpandedComments(prev => ({ ...prev, [postId]: !isExpanded }))
    
    if (!isExpanded && !comments[postId]) {
      loadComments(postId)
    }
  }

  // 提交评论
  const submitComment = async (postId: string) => {
    if (!accessToken) {
      alert('请先登录')
      return
    }
    
    const content = newComment[postId]?.trim()
    if (!content) return

    setCommentLoading(prev => ({ ...prev, [postId]: true }))
    
    try {
      const response = await fetch(`/api/posts/${postId}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ content }),
      })

      const result = await response.json()
      
      if (response.ok) {
        setNewComment(prev => ({ ...prev, [postId]: '' }))
        // 确保评论区展开
        setExpandedComments(prev => ({ ...prev, [postId]: true }))
        // 重新加载评论
        loadComments(postId)
        // 更新评论数
        setPosts(prev => prev.map(p => {
          if (p.id === postId) {
            return { ...p, comment_count: (p.comment_count || 0) + 1 }
          }
          return p
        }))
      } else {
        alert(result.error || '评论失败')
      }
    } catch (err: any) {
      alert('网络错误: ' + err.message)
    } finally {
      setCommentLoading(prev => ({ ...prev, [postId]: false }))
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="sm" color="tertiary" style={{ textAlign: 'center' }}>{t('loading')}</Text>
        </Box>
      </Box>
    )
  }

  if (error || !group) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[10] }}>
          <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[2], color: '#ff7c7c' }}>
            错误: {error || '小组不存在'}
          </Text>
          <Link href="/groups" style={{ color: tokens.colors.accent?.primary || tokens.colors.text.secondary, textDecoration: 'none', marginTop: tokens.spacing[3], display: 'inline-block' }}>
            ← 返回小组列表
          </Link>
        </Box>
      </Box>
    )
  }

  const handleJoin = async () => {
    if (!userId) {
      alert('请先登录')
      return
    }
    setJoining(true)
    try {
      const { error } = await supabase
        .from('group_members')
        .insert({ group_id: groupId, user_id: userId })
      if (error) throw error
      setIsMember(true)
    } catch (err: any) {
      alert('加入失败: ' + err.message)
    } finally {
      setJoining(false)
    }
  }

  const handleLeave = async () => {
    if (!userId) return
    setJoining(true)
    try {
      const { error } = await supabase
        .from('group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('user_id', userId)
      if (error) throw error
      setIsMember(false)
    } catch (err: any) {
      alert('退出失败: ' + err.message)
    } finally {
      setJoining(false)
    }
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box as="main" style={{ maxWidth: 900, margin: '0 auto', padding: `${tokens.spacing[6]} ${tokens.spacing[4]}` }}>
        {/* Group Header */}
        <Box
          style={{
            marginBottom: tokens.spacing[6],
            padding: tokens.spacing[6],
            background: tokens.colors.bg.secondary,
            borderRadius: tokens.radius.xl,
            border: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box style={{ display: 'flex', gap: tokens.spacing[4], alignItems: 'flex-start' }}>
            {/* Avatar */}
            <Box
              style={{
                width: 80,
                height: 80,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.tertiary || tokens.colors.bg.primary,
                border: `2px solid ${tokens.colors.border.primary}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              {group.avatar_url ? (
                <img
                  src={group.avatar_url}
                  alt={group.name}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <Text size="2xl" weight="bold" color="tertiary">
                  {group.name.charAt(0).toUpperCase()}
                </Text>
              )}
            </Box>

            {/* Info */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                <Box>
                  {/* 可点击的小组名称 */}
                  <Text 
                    size="2xl" 
                    weight="black" 
                    style={{ 
                      marginBottom: tokens.spacing[1],
                      cursor: 'pointer',
                    }}
                    onClick={() => setShowGroupInfo(true)}
                  >
                    {language === 'en' && group.name_en ? group.name_en : group.name}
                    <span style={{ 
                      fontSize: tokens.typography.fontSize.xs, 
                      color: tokens.colors.text.tertiary,
                      marginLeft: tokens.spacing[2],
                    }}>
                      ▼
                    </span>
                  </Text>
                  
                  {/* 可点击的成员数 */}
                  {group.member_count !== null && group.member_count !== undefined && (
                    <Text 
                      size="sm" 
                      color="tertiary"
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setShowMembersList(true)
                        loadMembers()
                      }}
                    >
                      <span style={{ 
                        textDecoration: 'underline',
                        textDecorationStyle: 'dotted',
                      }}>
                        {group.member_count} {language === 'zh' ? '位成员' : 'members'}
                      </span>
                    </Text>
                  )}
                  
                  {/* 组长信息 */}
                  {group.owner_handle && (
                    <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                      {language === 'zh' ? '组长' : 'Owner'}: 
                      <Link 
                        href={`/u/${group.owner_handle}`}
                        style={{ 
                          color: tokens.colors.accent?.primary || '#8b6fa8', 
                          textDecoration: 'none',
                          marginLeft: tokens.spacing[1],
                        }}
                      >
                        @{group.owner_handle}
                      </Link>
                    </Text>
                  )}
                </Box>
                <Link 
                  href="/groups" 
                  style={{ 
                    color: tokens.colors.accent?.primary || tokens.colors.text.secondary, 
                    textDecoration: 'none',
                    fontSize: tokens.typography.fontSize.sm,
                    fontWeight: tokens.typography.fontWeight.semibold,
                  }}
                >
                  ← {language === 'zh' ? '返回' : 'Back'}
                </Link>
              </Box>


              {/* Join/Leave Button */}
              <Box style={{ marginTop: tokens.spacing[4] }}>
                {userId ? (
                  isMember ? (
                    <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => window.location.href = `/groups/${groupId}/new`}
                      >
                        + 发新帖
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleLeave}
                        disabled={joining}
                      >
                        {joining ? '退出中...' : '退出小组'}
                      </Button>
                    </Box>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleJoin}
                      disabled={joining}
                    >
                      {joining ? '加入中...' : '+ 加入小组'}
                    </Button>
                  )
                ) : (
                  <Link href="/login">
                    <Button variant="primary" size="sm">
                      登录后加入
                    </Button>
                  </Link>
                )}
              </Box>
            </Box>
          </Box>
        </Box>

        {/* Posts Section */}
        <Box style={{ position: 'relative' }}>
          {/* Sort Tabs */}
          <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
            <Button
              variant={sortMode === 'latest' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setSortMode('latest')}
            >
              最新
            </Button>
            <Button
              variant={sortMode === 'hot' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setSortMode('hot')}
            >
              热门
            </Button>
          </Box>

          <Card title={`帖子 (${sortedPosts.length})`}>
            {sortedPosts.length === 0 ? (
              <Box style={{ 
                color: tokens.colors.text.tertiary, 
                padding: `${tokens.spacing[10]} ${tokens.spacing[5]}`,
                textAlign: 'center',
              }}>
                <Text size="sm" color="tertiary">
                  还没有帖子，成为第一个发帖的人吧！
                </Text>
              </Box>
            ) : (
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {sortedPosts.map((post) => (
                  <Box
                    key={post.id}
                    style={{
                      display: 'flex',
                      borderRadius: tokens.radius.xl,
                      background: tokens.colors.bg.secondary,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      transition: `all ${tokens.transition.base}`,
                      overflow: 'hidden',
                    }}
                  >
                    {/* 热度指示条 */}
                    <Box
                      style={{
                        width: 4,
                        minHeight: '100%',
                        background: getHeatColor(post.comment_count || 0, maxComments),
                        flexShrink: 0,
                      }}
                      title={`${post.comment_count || 0} ${language === 'zh' ? '条评论' : 'comments'}`}
                    />
                    
                    {/* 帖子内容 */}
                    <Box style={{ flex: 1, padding: tokens.spacing[4] }}>
                      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: tokens.spacing[2] }}>
                        <Text size="lg" weight="bold">
                          {translatedPosts[post.id]?.title || post.title}
                        </Text>
                        <Text size="xs" color="tertiary">
                          {new Date(post.created_at).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US')}
                        </Text>
                      </Box>

                    {post.author_handle && (
                      <Box style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.secondary, marginBottom: tokens.spacing[2], display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                        <Text size="xs" color="secondary">
                          {language === 'zh' ? '作者' : 'Author'}:{' '}
                        </Text>
                        <Link 
                          href={`/u/${encodeURIComponent(post.author_handle)}`} 
                          onClick={(e) => e.stopPropagation()}
                          style={{ 
                            color: tokens.colors.accent?.primary || '#8b6fa8', 
                            textDecoration: 'none',
                            fontWeight: tokens.typography.fontWeight.bold,
                            fontSize: tokens.typography.fontSize.xs,
                            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                            borderRadius: tokens.radius.md,
                            background: 'rgba(139, 111, 168, 0.1)',
                            transition: `all ${tokens.transition.base}`,
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(139, 111, 168, 0.2)'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'rgba(139, 111, 168, 0.1)'
                          }}
                        >
                          @{post.author_handle}
                        </Link>
                      </Box>
                    )}

                    {post.content && (() => {
                      const displayContent = translatedPosts[post.id]?.content || post.content
                      const isLongContent = displayContent.length > 150
                      const isExpanded = expandedPosts[post.id]
                      const contentToShow = isExpanded || !isLongContent 
                        ? displayContent 
                        : displayContent.slice(0, 150) + '...'
                      
                      return (
                        <Box style={{ marginTop: tokens.spacing[3] }}>
                          <Text size="sm" color="secondary" style={{ 
                            lineHeight: 1.6,
                            whiteSpace: 'pre-wrap',
                          }}>
                            {renderContentWithLinks(contentToShow)}
                          </Text>
                          {isLongContent && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setExpandedPosts(prev => ({ ...prev, [post.id]: !prev[post.id] }))
                              }}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: ARENA_PURPLE,
                                cursor: 'pointer',
                                fontSize: 12,
                                marginTop: tokens.spacing[2],
                                padding: 0,
                              }}
                            >
                              {isExpanded 
                                ? (language === 'zh' ? '收起' : 'Show less') 
                                : (language === 'zh' ? '展开查看' : 'Show more')}
                            </button>
                          )}
                        </Box>
                      )
                    })()}

                    <Box style={{ 
                      marginTop: tokens.spacing[3], 
                      display: 'flex', 
                      gap: tokens.spacing[4],
                      paddingTop: tokens.spacing[3],
                      borderTop: `1px solid ${tokens.colors.border.primary}`,
                    }}>
                      {/* 点赞 */}
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => handleLike(post.id)}
                        disabled={likeLoading[post.id]}
                        style={{ 
                          padding: 0, 
                          minWidth: 'auto',
                          color: post.user_liked ? tokens.colors.accent?.success : undefined,
                        }}
                      >
                        <ThumbsUpIcon size={14} />
                        <Text 
                          size="xs" 
                          style={{ 
                            marginLeft: tokens.spacing[1],
                            color: post.user_liked ? tokens.colors.accent?.success : tokens.colors.text.secondary,
                          }}
                        >
                          {post.like_count || 0}
                        </Text>
                      </Button>
                      
                      {/* 评论 */}
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => toggleComments(post.id)}
                        style={{ padding: 0, minWidth: 'auto' }}
                      >
                        <CommentIcon size={14} />
                        <Text size="xs" color="secondary" style={{ marginLeft: tokens.spacing[1] }}>
                          {post.comment_count || 0}
                        </Text>
                      </Button>

                      {/* 收藏 */}
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => handleBookmark(post.id)}
                        disabled={bookmarkLoading[post.id]}
                        style={{ 
                          padding: 0, 
                          minWidth: 'auto',
                          color: post.user_bookmarked ? '#FFB020' : undefined,
                        }}
                        title={language === 'zh' ? (post.user_bookmarked ? '取消收藏' : '收藏') : (post.user_bookmarked ? 'Remove bookmark' : 'Bookmark')}
                      >
                        <span style={{ fontSize: 14 }}>{post.user_bookmarked ? '★' : '☆'}</span>
                        <Text 
                          size="xs" 
                          style={{ 
                            marginLeft: tokens.spacing[1],
                            color: post.user_bookmarked ? '#FFB020' : tokens.colors.text.secondary,
                          }}
                        >
                          {post.bookmark_count || 0}
                        </Text>
                      </Button>

                      {/* 转发 */}
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => {
                          if (post.author_id === userId) {
                            alert(language === 'zh' ? '不能转发自己的帖子' : 'Cannot repost your own post')
                            return
                          }
                          if (post.user_reposted) {
                            alert(language === 'zh' ? '已经转发过此帖子' : 'Already reposted')
                            return
                          }
                          setShowRepostModal(post.id)
                        }}
                        disabled={repostLoading[post.id] || post.user_reposted}
                        style={{ 
                          padding: 0, 
                          minWidth: 'auto',
                          color: post.user_reposted ? tokens.colors.accent?.primary : undefined,
                        }}
                        title={language === 'zh' ? (post.user_reposted ? '已转发' : '转发') : (post.user_reposted ? 'Reposted' : 'Repost')}
                      >
                        <span style={{ fontSize: 14 }}>↗</span>
                        <Text 
                          size="xs" 
                          style={{ 
                            marginLeft: tokens.spacing[1],
                            color: post.user_reposted ? tokens.colors.accent?.primary : tokens.colors.text.secondary,
                          }}
                        >
                          {post.repost_count || 0}
                        </Text>
                      </Button>
                    </Box>

                    {/* 评论区 */}
                    {expandedComments[post.id] && (
                      <Box style={{ 
                        marginTop: tokens.spacing[3], 
                        paddingTop: tokens.spacing[3],
                        borderTop: `1px solid ${tokens.colors.border.primary}`,
                      }}>
                        {/* 评论输入框 */}
                        {accessToken && (
                          <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                            <input
                              type="text"
                              placeholder="写评论..."
                              value={newComment[post.id] || ''}
                              onChange={(e) => setNewComment(prev => ({ ...prev, [post.id]: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && submitComment(post.id)}
                              style={{
                                flex: 1,
                                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                                borderRadius: tokens.radius.md,
                                border: `1px solid ${tokens.colors.border.primary}`,
                                background: tokens.colors.bg.primary,
                                color: tokens.colors.text.primary,
                                fontSize: tokens.typography.fontSize.sm,
                              }}
                            />
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => submitComment(post.id)}
                              disabled={commentLoading[post.id] || !newComment[post.id]?.trim()}
                            >
                              发送
                            </Button>
                          </Box>
                        )}

                        {/* 评论列表 */}
                        {commentLoading[post.id] ? (
                          <Text size="xs" color="tertiary">加载中...</Text>
                        ) : comments[post.id]?.length > 0 ? (
                          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                            {comments[post.id].map((comment: any) => (
                              <Box 
                                key={comment.id}
                                style={{ 
                                  padding: tokens.spacing[2],
                                  background: tokens.colors.bg.primary,
                                  borderRadius: tokens.radius.md,
                                }}
                              >
                                <Box style={{ display: 'flex', justifyContent: 'space-between', marginBottom: tokens.spacing[1] }}>
                                  <Text size="xs" weight="bold" color="secondary">
                                    @{comment.author_handle || '匿名'}
                                  </Text>
                                  <Text size="xs" color="tertiary">
                                    {new Date(comment.created_at).toLocaleString('zh-CN')}
                                  </Text>
                                </Box>
                                <Text size="sm">{renderContentWithLinks(comment.content)}</Text>
                              </Box>
                            ))}
                          </Box>
                        ) : (
                          <Text size="xs" color="tertiary">暂无评论</Text>
                        )}
                      </Box>
                    )}
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Card>
        </Box>

        {/* Floating Post Button (右下角固定) */}
        {isMember && (
          <Link
            href={`/groups/${groupId}/new`}
            style={{
              position: 'fixed',
              bottom: tokens.spacing[6],
              right: tokens.spacing[6],
              width: 56,
              height: 56,
              borderRadius: '50%',
              background: tokens.colors.accent?.primary || tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '24px',
              fontWeight: 'bold',
              textDecoration: 'none',
              boxShadow: tokens.shadow.lg,
              zIndex: 1000,
              transition: `all ${tokens.transition.base}`,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.1)'
              e.currentTarget.style.boxShadow = tokens.shadow.xl
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)'
              e.currentTarget.style.boxShadow = tokens.shadow.lg
            }}
          >
            +
          </Link>
        )}

        {/* 转发弹窗 */}
        {showRepostModal && (
          <Box
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2000,
            }}
            onClick={() => {
              setShowRepostModal(null)
              setRepostComment('')
            }}
          >
            <Box
              style={{
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.xl,
                padding: tokens.spacing[6],
                width: '90%',
                maxWidth: 400,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Text size="lg" weight="bold" style={{ marginBottom: tokens.spacing[4] }}>
                {language === 'zh' ? '转发到主页' : 'Repost to Profile'}
              </Text>
              
              <textarea
                value={repostComment}
                onChange={(e) => setRepostComment(e.target.value)}
                placeholder={language === 'zh' ? '添加评论（可选）...' : 'Add a comment (optional)...'}
                style={{
                  width: '100%',
                  minHeight: 80,
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.lg,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: tokens.colors.text.primary,
                  fontSize: tokens.typography.fontSize.sm,
                  resize: 'vertical',
                  marginBottom: tokens.spacing[4],
                }}
                maxLength={280}
              />
              
              <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setShowRepostModal(null)
                    setRepostComment('')
                  }}
                >
                  {language === 'zh' ? '取消' : 'Cancel'}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleRepost(showRepostModal, repostComment)}
                  disabled={repostLoading[showRepostModal]}
                >
                  {repostLoading[showRepostModal] 
                    ? (language === 'zh' ? '转发中...' : 'Reposting...') 
                    : (language === 'zh' ? '转发' : 'Repost')}
                </Button>
              </Box>
            </Box>
          </Box>
        )}

        {/* 小组信息弹窗 */}
        {showGroupInfo && group && (
          <Box
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2000,
            }}
            onClick={() => setShowGroupInfo(false)}
          >
            <Box
              style={{
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.xl,
                padding: tokens.spacing[6],
                width: '90%',
                maxWidth: 500,
                maxHeight: '80vh',
                overflowY: 'auto',
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 头部 */}
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
                <Text size="xl" weight="bold">
                  {language === 'zh' ? '小组信息' : 'Group Info'}
                </Text>
                <button
                  onClick={() => setShowGroupInfo(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: 20,
                    cursor: 'pointer',
                    color: tokens.colors.text.tertiary,
                  }}
                >
                  ×
                </button>
              </Box>
              
              {/* 小组信息详情 */}
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                {/* 组长 */}
                <Box>
                  <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {language === 'zh' ? '组长' : 'Owner'}
                  </Text>
                  <Text size="md">
                    {group.owner_handle ? (
                      <Link 
                        href={`/u/${group.owner_handle}`}
                        style={{ color: tokens.colors.accent?.primary || '#8b6fa8', textDecoration: 'none' }}
                      >
                        @{group.owner_handle}
                      </Link>
                    ) : (
                      language === 'zh' ? '暂无' : 'None'
                    )}
                  </Text>
                </Box>
                
                {/* 小组简介 */}
                <Box>
                  <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {language === 'zh' ? '小组简介' : 'Description'}
                  </Text>
                  <Text size="md" style={{ lineHeight: 1.6 }}>
                    {(language === 'en' && group.description_en ? group.description_en : group.description) || 
                      (language === 'zh' ? '暂无简介' : 'No description')}
                  </Text>
                </Box>
                
                {/* 发言规则 */}
                <Box>
                  <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {language === 'zh' ? '发言规则' : 'Rules'}
                  </Text>
                  <Text size="md" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                    {group.rules || (language === 'zh' ? '暂无规则' : 'No rules set')}
                  </Text>
                </Box>
                
                {/* 创建时间 */}
                <Box>
                  <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {language === 'zh' ? '创建时间' : 'Created'}
                  </Text>
                  <Text size="md">
                    {group.created_at 
                      ? new Date(group.created_at).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })
                      : (language === 'zh' ? '未知' : 'Unknown')
                    }
                  </Text>
                </Box>
                
                {/* 成员数 */}
                <Box>
                  <Text size="sm" weight="semibold" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                    {language === 'zh' ? '成员数' : 'Members'}
                  </Text>
                  <Text 
                    size="md" 
                    style={{ cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => {
                      setShowGroupInfo(false)
                      setShowMembersList(true)
                      loadMembers()
                    }}
                  >
                    {group.member_count || 0} {language === 'zh' ? '位成员' : 'members'}
                  </Text>
                </Box>
              </Box>
              
              <Box style={{ marginTop: tokens.spacing[6], textAlign: 'right' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowGroupInfo(false)}
                >
                  {language === 'zh' ? '关闭' : 'Close'}
                </Button>
              </Box>
            </Box>
          </Box>
        )}

        {/* 成员列表弹窗 */}
        {showMembersList && (
          <Box
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0, 0, 0, 0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 2000,
            }}
            onClick={() => setShowMembersList(false)}
          >
            <Box
              style={{
                background: tokens.colors.bg.primary,
                borderRadius: tokens.radius.xl,
                padding: tokens.spacing[6],
                width: '90%',
                maxWidth: 400,
                maxHeight: '80vh',
                overflowY: 'auto',
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 头部 */}
              <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
                <Text size="xl" weight="bold">
                  {language === 'zh' ? '小组成员' : 'Members'} ({group?.member_count || 0})
                </Text>
                <button
                  onClick={() => setShowMembersList(false)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    fontSize: 20,
                    cursor: 'pointer',
                    color: tokens.colors.text.tertiary,
                  }}
                >
                  ×
                </button>
              </Box>
              
              {/* 成员列表 */}
              {loadingMembers ? (
                <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                  {language === 'zh' ? '加载中...' : 'Loading...'}
                </Text>
              ) : members.length === 0 ? (
                <Text color="tertiary" style={{ textAlign: 'center', padding: tokens.spacing[4] }}>
                  {language === 'zh' ? '暂无成员' : 'No members'}
                </Text>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                  {members.map((member) => (
                    <Link
                      key={member.user_id}
                      href={`/u/${member.handle || member.user_id}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[3],
                        padding: tokens.spacing[2],
                        borderRadius: tokens.radius.md,
                        textDecoration: 'none',
                        color: tokens.colors.text.primary,
                        transition: `background ${tokens.transition.base}`,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = tokens.colors.bg.secondary
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      {/* 头像 */}
                      <Box
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          background: tokens.colors.bg.tertiary || tokens.colors.bg.secondary,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          flexShrink: 0,
                        }}
                      >
                        {member.avatar_url ? (
                          <img 
                            src={member.avatar_url} 
                            alt={member.handle || 'User'} 
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          />
                        ) : (
                          <Text size="sm" color="tertiary">
                            {(member.handle || 'U').charAt(0).toUpperCase()}
                          </Text>
                        )}
                      </Box>
                      
                      {/* 用户名和角色 */}
                      <Box style={{ flex: 1 }}>
                        <Text size="sm" weight="medium">
                          @{member.handle || 'Unknown'}
                        </Text>
                      </Box>
                      
                      {/* 角色标签 */}
                      <span
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                          borderRadius: tokens.radius.full,
                          background: member.role === 'owner' 
                            ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                            : member.role === 'admin' 
                              ? 'linear-gradient(135deg, #8b6fa8, #6b4f88)'
                              : tokens.colors.bg.tertiary || tokens.colors.bg.secondary,
                          color: member.role === 'owner' || member.role === 'admin' 
                            ? '#fff' 
                            : tokens.colors.text.secondary,
                          fontWeight: tokens.typography.fontWeight.semibold,
                        }}
                      >
                        {member.role === 'owner' 
                          ? (language === 'zh' ? '组长' : 'Owner')
                          : member.role === 'admin'
                            ? (language === 'zh' ? '管理员' : 'Admin')
                            : (language === 'zh' ? '成员' : 'Member')
                        }
                      </span>
                    </Link>
                  ))}
                </Box>
              )}
              
              <Box style={{ marginTop: tokens.spacing[4], textAlign: 'right' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowMembersList(false)}
                >
                  {language === 'zh' ? '关闭' : 'Close'}
                </Button>
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  )
}
