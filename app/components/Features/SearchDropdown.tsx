'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { CloseIcon } from '../Icons'
import { supabase } from '@/lib/supabase/client'

interface SearchDropdownProps {
  open: boolean
  query: string
  onClose: () => void
}

interface SearchHistoryItem {
  id: string
  query: string
  timestamp: number
}

interface HotPost {
  id: string
  title: string
  hotScore: number
  rank: number
  view_count?: number
}

/**
 * 搜索下拉菜单
 * - 显示搜索历史记录（可删除）
 * - 显示热榜帖子前十（前三标橙）
 */
export default function SearchDropdown({ open, onClose }: SearchDropdownProps) {
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([])
  const [hotPosts, setHotPosts] = useState<HotPost[]>([])
  const [loading, setLoading] = useState(false)

  // 加载搜索历史
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('searchHistory')
      if (stored) {
        try {
          setSearchHistory(JSON.parse(stored))
        } catch (e) {
          console.error('Failed to parse search history:', e)
        }
      }
    }
  }, [])

  // 从数据库加载热榜帖子
  const loadHotPosts = useCallback(async () => {
    if (!open) return
    
    setLoading(true)
    try {
      // 从数据库获取热门帖子（按 hot_score 或综合排序）
      const { data, error } = await supabase
        .from('posts')
        .select('id, title, hot_score, view_count, like_count, comment_count')
        .order('hot_score', { ascending: false, nullsFirst: false })
        .order('view_count', { ascending: false, nullsFirst: false })
        .order('like_count', { ascending: false, nullsFirst: false })
        .limit(10)

      if (error) {
        console.error('Failed to load hot posts:', error)
        return
      }

      if (data && data.length > 0) {
        const posts: HotPost[] = data.map((post, index) => ({
          id: post.id,
          title: post.title || '无标题',
          hotScore: post.hot_score || 
            (post.view_count || 0) * 0.1 + 
            (post.like_count || 0) * 2 + 
            (post.comment_count || 0) * 3,
          rank: index + 1,
          view_count: post.view_count,
        }))
        setHotPosts(posts)
      }
    } catch (e) {
      console.error('Failed to load hot posts:', e)
    } finally {
      setLoading(false)
    }
  }, [open])

  useEffect(() => {
    loadHotPosts()
  }, [loadHotPosts])

  // 删除单个历史记录
  const handleDeleteHistory = (id: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const newHistory = searchHistory.filter((item) => item.id !== id)
    setSearchHistory(newHistory)
    if (typeof window !== 'undefined') {
      localStorage.setItem('searchHistory', JSON.stringify(newHistory))
    }
  }

  // 清空所有历史记录
  const handleClearAllHistory = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSearchHistory([])
    if (typeof window !== 'undefined') {
      localStorage.removeItem('searchHistory')
    }
  }

  if (!open) return null

  return (
    <Box
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        left: 0,
        right: 0,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.md,
        maxHeight: 600,
        overflowY: 'auto',
        zIndex: tokens.zIndex.dropdown,
        boxShadow: tokens.shadow.md,
      }}
    >
      {/* 搜索历史 */}
      {searchHistory.length > 0 && (
        <Box>
          <Box
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
              搜索历史
            </Text>
            <button
              onClick={handleClearAllHistory}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                padding: 0,
              }}
            >
              清空
            </button>
          </Box>
          <Box>
            {searchHistory.map((item) => (
              <Box
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <Link
                  href={`/search?q=${encodeURIComponent(item.query)}`}
                  style={{ textDecoration: 'none', flex: 1 }}
                  onClick={onClose}
                >
                  <Text size="sm" style={{ color: tokens.colors.text.primary }}>
                    {item.query}
                  </Text>
                </Link>
                <button
                  onClick={(e) => handleDeleteHistory(item.id, e)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.colors.text.tertiary,
                    cursor: 'pointer',
                    padding: tokens.spacing[1],
                    display: 'flex',
                    alignItems: 'center',
                    marginLeft: tokens.spacing[2],
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = tokens.colors.text.secondary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = tokens.colors.text.tertiary
                  }}
                >
                  <CloseIcon size={14} />
                </button>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {/* 热榜帖子 */}
      <Box>
        <Box
          style={{
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            borderBottom: searchHistory.length > 0 ? `1px solid ${tokens.colors.border.primary}` : 'none',
          }}
        >
          <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
            热榜帖子
          </Text>
        </Box>
        <Box>
          {loading ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">加载中...</Text>
            </Box>
          ) : hotPosts.length === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">暂无热门帖子</Text>
            </Box>
          ) : (
            hotPosts.map((post) => (
              <Link
                key={post.id}
                href={`/groups?post=${post.id}`}
                style={{ textDecoration: 'none' }}
                onClick={onClose}
              >
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.spacing[3],
                    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                    borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = tokens.colors.bg.tertiary
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {/* 排名 - 前三标橙 */}
                  <Text
                    size="sm"
                    weight="black"
                    style={{
                      color: post.rank <= 3 ? '#FF9800' : tokens.colors.text.tertiary, // 橙色
                      minWidth: 24,
                      textAlign: 'right',
                    }}
                  >
                    {post.rank}
                  </Text>
                  <Box style={{ flex: 1 }}>
                    <Text
                      size="sm"
                      style={{
                        color: tokens.colors.text.primary,
                        lineHeight: 1.5,
                      }}
                    >
                      {post.title}
                    </Text>
                    {post.view_count !== undefined && post.view_count > 0 && (
                      <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                        {post.view_count.toLocaleString()} 浏览
                      </Text>
                    )}
                  </Box>
                </Box>
              </Link>
            ))
          )}
        </Box>
      </Box>
    </Box>
  )
}
