'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { CloseIcon } from '../icons'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '../UI/Toast'

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

interface SearchResult {
  id: string
  type: 'trader' | 'post' | 'group'
  title: string
  subtitle?: string
  href: string
}

/**
 * 搜索下拉菜单
 * - 实时搜索建议
 * - 显示搜索历史记录（可删除）
 * - 显示热榜帖子前十（前三标橙）
 */
export default function SearchDropdown({ open, query, onClose }: SearchDropdownProps) {
  const { showToast } = useToast()
  const [searchHistory, setSearchHistory] = useState<SearchHistoryItem[]>([])
  const [hotPosts, setHotPosts] = useState<HotPost[]>([])
  const [loading, setLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)

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
        // 静默处理热榜加载失败，不影响用户搜索体验
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

  // 实时搜索
  useEffect(() => {
    if (!open || !query.trim() || query.length < 2) {
      setSearchResults([])
      return
    }

    const searchTimer = setTimeout(async () => {
      setSearching(true)
      const results: SearchResult[] = []

      try {
        // 搜索交易员
        const { data: traders } = await supabase
          .from('trader_sources')
          .select('source_trader_id, handle, source')
          .ilike('handle', `%${query}%`)
          .limit(5)

        if (traders) {
          traders.forEach((trader: any) => {
            results.push({
              id: trader.source_trader_id,
              type: 'trader',
              title: trader.handle || '未知交易员',
              subtitle: trader.source?.toUpperCase(),
              href: `/trader/${encodeURIComponent(trader.handle || trader.source_trader_id)}`,
            })
          })
        }

        // 搜索帖子
        const { data: posts } = await supabase
          .from('posts')
          .select('id, title, author_handle')
          .or(`title.ilike.%${query}%`)
          .limit(5)

        if (posts) {
          posts.forEach((post: any) => {
            results.push({
              id: post.id,
              type: 'post',
              title: post.title || '无标题',
              subtitle: post.author_handle ? `@${post.author_handle}` : undefined,
              href: `/groups?post=${post.id}`,
            })
          })
        }

        // 搜索群组
        const { data: groups } = await supabase
          .from('groups')
          .select('id, name')
          .ilike('name', `%${query}%`)
          .limit(3)

        if (groups) {
          groups.forEach((group: any) => {
            results.push({
              id: group.id,
              type: 'group',
              title: group.name,
              href: `/groups/${group.id}`,
            })
          })
        }

        setSearchResults(results)
        setSearchError(false)
      } catch (error) {
        console.error('Search error:', error)
        setSearchError(true)
        showToast('搜索失败，请稍后重试', 'error')
      } finally {
        setSearching(false)
      }
    }, 300) // 300ms 防抖

    return () => clearTimeout(searchTimer)
  }, [query, open])

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

  // 保存搜索到历史记录
  const saveToHistory = (searchQuery: string) => {
    if (!searchQuery.trim()) return
    
    const newItem: SearchHistoryItem = {
      id: Date.now().toString(),
      query: searchQuery.trim(),
      timestamp: Date.now(),
    }
    
    // 移除重复项，添加新项到最前面
    const newHistory = [
      newItem,
      ...searchHistory.filter(item => item.query !== searchQuery.trim())
    ].slice(0, 10) // 最多保留10条
    
    setSearchHistory(newHistory)
    if (typeof window !== 'undefined') {
      localStorage.setItem('searchHistory', JSON.stringify(newHistory))
    }
  }

  // 点击搜索结果时保存到历史
  const handleResultClick = () => {
    if (query.trim()) {
      saveToHistory(query)
    }
    onClose()
  }

  if (!open) return null

  const getTypeLabel = (type: string) => {
    switch (type) {
      case 'trader': return '交易员'
      case 'post': return '帖子'
      case 'group': return '群组'
      default: return ''
    }
  }

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'trader': return 'T'
      case 'post': return 'P'
      case 'group': return 'G'
      default: return ''
    }
  }

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
      {/* 实时搜索结果 */}
      {query.trim().length >= 2 && (
        <Box>
          <Box
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="xs" weight="bold" color="tertiary" style={{ textTransform: 'uppercase' }}>
              搜索结果
            </Text>
          </Box>
          {searching ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">搜索中...</Text>
            </Box>
          ) : searchResults.length === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">未找到相关结果</Text>
            </Box>
          ) : (
            searchResults.map((result) => (
              <Link
                key={`${result.type}-${result.id}`}
                href={result.href}
                style={{ textDecoration: 'none' }}
                onClick={handleResultClick}
              >
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
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
                  <Text size="lg">{getTypeIcon(result.type)}</Text>
                  <Box style={{ flex: 1 }}>
                    <Text size="sm" style={{ color: tokens.colors.text.primary }}>
                      {result.title}
                    </Text>
                    <Box style={{ display: 'flex', gap: tokens.spacing[2], marginTop: 2 }}>
                      <Text size="xs" color="tertiary">{getTypeLabel(result.type)}</Text>
                      {result.subtitle && (
                        <Text size="xs" color="tertiary">· {result.subtitle}</Text>
                      )}
                    </Box>
                  </Box>
                </Box>
              </Link>
            ))
          )}
        </Box>
      )}

      {/* 搜索历史 - 仅在没有输入查询时显示 */}
      {query.trim().length < 2 && searchHistory.length > 0 && (
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

      {/* 热榜帖子 - 仅在没有输入查询时显示 */}
      {query.trim().length < 2 && (
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
              // 骨架屏加载状态，避免布局跳动
              <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
                {[1, 2, 3, 4, 5].map((i) => (
                  <Box
                    key={i}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: tokens.spacing[3],
                      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                      borderBottom: `1px solid ${tokens.colors.border.primary}`,
                    }}
                  >
                    <Box
                      style={{
                        width: 24,
                        height: 16,
                        background: tokens.colors.bg.tertiary,
                        borderRadius: tokens.radius.sm,
                        animation: 'pulse 1.5s ease-in-out infinite',
                      }}
                    />
                    <Box style={{ flex: 1 }}>
                      <Box
                        style={{
                          width: `${60 + Math.random() * 30}%`,
                          height: 14,
                          background: tokens.colors.bg.tertiary,
                          borderRadius: tokens.radius.sm,
                          animation: 'pulse 1.5s ease-in-out infinite',
                        }}
                      />
                    </Box>
                  </Box>
                ))}
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
      )}
    </Box>
  )
}
