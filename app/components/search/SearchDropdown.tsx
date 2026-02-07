'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { CloseIcon } from '../ui/icons'
import { supabase } from '@/lib/supabase/client'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  initializeHistory,
  addToHistory,
  removeFromHistory,
  clearHistory,
} from '@/lib/services/search-history'
import { useAuthSession } from '@/lib/hooks/useAuthSession'

interface SearchDropdownProps {
  open: boolean
  query: string
  onClose: () => void
}

// Search history is stored as a simple string[] in localStorage under 'ranking-arena-recent-searches'

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
  roi?: number
}

/**
 * 搜索下拉菜单
 * - 实时搜索建议（通过 API）
 * - 键盘导航（上下箭头、Enter、Escape）
 * - 显示搜索历史记录（可删除）
 * - 显示热榜帖子前十（前三标橙）
 */
export default function SearchDropdown({ open, query, onClose }: SearchDropdownProps) {
  const router = useRouter()
  const { language } = useLanguage()
  const { userId, isLoggedIn, authChecked } = useAuthSession()
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [hotPosts, setHotPosts] = useState<HotPost[]>([])
  const [loading, setLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({})
  const [translating, setTranslating] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 加载搜索历史 - 当认证状态确定后加载
  useEffect(() => {
    if (!authChecked) return

    const loadHistory = async () => {
      const history = await initializeHistory(userId ?? undefined)
      setSearchHistory(history)
    }

    loadHistory()
  }, [authChecked, userId, isLoggedIn])

  // 从数据库加载热榜帖子
  const loadHotPosts = useCallback(async () => {
    if (!open) return

    setLoading(true)
    try {
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

  // Auto-translate hot post titles to match current language
  useEffect(() => {
    if (hotPosts.length === 0 || translating) return

    // Check if we already have translations for current language
    const langKey = (id: string) => `${language}:${id}`
    const needsTranslation = hotPosts.some(post => !translatedTitles[langKey(post.id)])
    if (!needsTranslation) return

    // Detect if title needs translation (simple heuristic: check if mostly CJK or Latin)
    const isCJK = (text: string) => /[\u4e00-\u9fff\u3000-\u303f]/.test(text)
    const postsToTranslate = hotPosts.filter(post => {
      if (translatedTitles[langKey(post.id)]) return false
      const titleIsCJK = isCJK(post.title)
      // If language is zh and title is already Chinese, skip
      if (language === 'zh' && titleIsCJK) return false
      // If language is en and title is already English, skip
      if (language === 'en' && !titleIsCJK) return false
      return true
    })

    if (postsToTranslate.length === 0) {
      // Mark non-needing posts as already "translated" (identity)
      const newTranslations = { ...translatedTitles }
      hotPosts.forEach(post => {
        if (!newTranslations[langKey(post.id)]) {
          newTranslations[langKey(post.id)] = post.title
        }
      })
      setTranslatedTitles(newTranslations)
      return
    }

    const translateTitles = async () => {
      setTranslating(true)
      try {
        const textsToTranslate = postsToTranslate.map(p => p.title).join('\n---SPLIT---\n')
        const targetLang = language === 'zh' ? 'zh' : 'en'
        const sourceLang = language === 'zh' ? 'en' : 'zh'

        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: textsToTranslate,
            targetLang,
            sourceLang,
          }),
        })

        if (res.ok) {
          const data = await res.json()
          const translatedTexts = (data.translatedText || '').split('\n---SPLIT---\n')

          const newTranslations: Record<string, string> = { ...translatedTitles }
          postsToTranslate.forEach((post, idx) => {
            if (translatedTexts[idx]) {
              newTranslations[langKey(post.id)] = translatedTexts[idx].trim()
            }
          })
          // Also mark untranslated posts
          hotPosts.forEach(post => {
            if (!newTranslations[langKey(post.id)]) {
              newTranslations[langKey(post.id)] = post.title
            }
          })
          setTranslatedTitles(newTranslations)
        }
      } catch (e) {
        console.error('Failed to translate hot posts:', e)
      } finally {
        setTranslating(false)
      }
    }

    translateTitles()
  }, [language, hotPosts, translatedTitles, translating])

  // 实时搜索 - 使用 API 和 AbortController
  useEffect(() => {
    if (!open || !query.trim() || query.length < 2) {
      setSearchResults([])
      setSelectedIndex(-1)
      return
    }

    const searchTimer = setTimeout(async () => {
      // Cancel previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      const controller = new AbortController()
      abortControllerRef.current = controller

      setSearching(true)

      try {
        // Use the search suggestions API
        const response = await fetch(
          `/api/search/suggestions?q=${encodeURIComponent(query.trim())}&limit=10`,
          { signal: controller.signal }
        )

        if (!response.ok) throw new Error('Search failed')

        const data = await response.json()
        const suggestions = data.suggestions || []

        const results: SearchResult[] = suggestions.map((s: { type: string; value: string; label: string; subLabel?: string; source?: string; roi?: number }) => {
          let href: string
          let type: 'trader' | 'post' | 'group'

          if (s.type === 'trader') {
            type = 'trader'
            href = `/trader/${encodeURIComponent(s.value)}`
          } else if (s.type === 'symbol') {
            type = 'trader'
            href = `/search?q=${encodeURIComponent(s.value)}`
          } else {
            type = 'post'
            href = `/search?q=${encodeURIComponent(s.value)}`
          }

          return {
            id: `${s.type}-${s.value}`,
            type,
            title: s.label,
            subtitle: s.subLabel,
            href,
            roi: s.roi,
          }
        })

        // Also search posts and groups from Supabase for dropdown enrichment
        const sanitizedQuery = query.trim()
          .slice(0, 100)
          .replace(/[\\%_]/g, c => `\\${c}`)

        const [postsRes, groupsRes] = await Promise.all([
          supabase
            .from('posts')
            .select('id, title, author_handle')
            .or(`title.ilike.%${sanitizedQuery}%`)
            .limit(3),
          supabase
            .from('groups')
            .select('id, name, name_en')
            .or(`name.ilike.%${sanitizedQuery}%,name_en.ilike.%${sanitizedQuery}%`)
            .limit(3),
        ])

        if (postsRes.data) {
          postsRes.data.forEach((post) => {
            results.push({
              id: post.id,
              type: 'post',
              title: post.title || (language === 'zh' ? '无标题' : 'Untitled'),
              subtitle: post.author_handle ? `@${post.author_handle}` : undefined,
              href: `/post/${post.id}`,
            })
          })
        }

        if (groupsRes.data) {
          groupsRes.data.forEach((group) => {
            results.push({
              id: group.id,
              type: 'group',
              title: language === 'zh' ? group.name : (group.name_en || group.name),
              href: `/groups/${group.id}`,
            })
          })
        }

        if (!controller.signal.aborted) {
          setSearchResults(results)
          setSelectedIndex(-1)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        console.error('Search error:', error)
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false)
        }
      }
    }, 300) // 300ms 防抖

    return () => {
      clearTimeout(searchTimer)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [query, open, language])

  // 保存搜索到历史记录
  const saveToHistory = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) return
    const newHistory = await addToHistory(searchQuery, userId ?? undefined)
    setSearchHistory(newHistory)
  }, [userId])

  // Keyboard navigation
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (searchResults.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev =>
          prev < searchResults.length - 1 ? prev + 1 : 0
        )
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev =>
          prev > 0 ? prev - 1 : searchResults.length - 1
        )
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault()
        const selected = searchResults[selectedIndex]
        if (selected) {
          saveToHistory(query)
          router.push(selected.href)
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, searchResults, selectedIndex, query, onClose, router, saveToHistory])

  // 删除单个历史记录
  const handleDeleteHistory = async (term: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const newHistory = await removeFromHistory(term, userId ?? undefined)
    setSearchHistory(newHistory)
  }

  // 清空所有历史记录
  const handleClearAllHistory = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await clearHistory(userId ?? undefined)
    setSearchHistory([])
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
    <div
      ref={containerRef}
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
            <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
              {[1, 2, 3].map((i) => (
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
                  <Box style={{ width: 28, height: 28, borderRadius: tokens.radius.md, background: tokens.colors.bg.tertiary, animation: 'pulse 1.5s ease-in-out infinite', flexShrink: 0 }} />
                  <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Box style={{ width: `${50 + i * 15}%`, height: 12, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm, animation: 'pulse 1.5s ease-in-out infinite' }} />
                    <Box style={{ width: `${30 + i * 10}%`, height: 10, background: tokens.colors.bg.tertiary, borderRadius: tokens.radius.sm, animation: 'pulse 1.5s ease-in-out infinite', opacity: 0.6 }} />
                  </Box>
                </Box>
              ))}
            </Box>
          ) : searchResults.length === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">未找到相关结果</Text>
            </Box>
          ) : (
            searchResults.map((result, index) => (
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
                    background: index === selectedIndex ? tokens.colors.bg.tertiary : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    setSelectedIndex(index)
                    e.currentTarget.style.background = tokens.colors.bg.tertiary
                  }}
                  onMouseLeave={(e) => {
                    if (index !== selectedIndex) {
                      e.currentTarget.style.background = 'transparent'
                    }
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
                  {result.roi !== undefined && (
                    <Text
                      size="xs"
                      style={{ color: result.roi >= 0 ? '#22c55e' : '#ef4444' }}
                    >
                      {result.roi >= 0 ? '+' : ''}{result.roi.toFixed(1)}%
                    </Text>
                  )}
                </Box>
              </Link>
            ))
          )}
          {/* 查看全部搜索结果链接 */}
          {searchResults.length > 0 && (
            <Link
              href={`/search?q=${encodeURIComponent(query)}`}
              style={{ textDecoration: 'none' }}
              onClick={handleResultClick}
            >
              <Box
                style={{
                  padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
                  textAlign: 'center',
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <Text size="xs" color="tertiary">
                  查看全部搜索结果 →
                </Text>
              </Box>
            </Link>
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
              {language === 'en' ? 'Search History' : '搜索历史'}
            </Text>
            <button
              onClick={handleClearAllHistory}
              aria-label={language === 'en' ? 'Clear search history' : '清空搜索历史'}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                padding: 0,
              }}
            >
              {language === 'en' ? 'Clear' : '清空'}
            </button>
          </Box>
          <Box>
            {searchHistory.map((term, idx) => (
              <Box
                key={`${term}-${idx}`}
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
                  href={`/search?q=${encodeURIComponent(term)}`}
                  style={{ textDecoration: 'none', flex: 1 }}
                  onClick={onClose}
                >
                  <Text size="sm" style={{ color: tokens.colors.text.primary }}>
                    {term}
                  </Text>
                </Link>
                <button
                  onClick={(e) => handleDeleteHistory(term, e)}
                  aria-label={`删除搜索记录: ${term}`}
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
              {language === 'en' ? 'Hot Posts' : '热榜帖子'}
            </Text>
          </Box>
          <Box>
            {loading ? (
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
                <Text size="sm" color="tertiary">
                  {language === 'en' ? 'No hot posts yet' : '暂无热门帖子'}
                </Text>
              </Box>
            ) : (
              hotPosts.map((post) => (
                <Link
                  key={post.id}
                  href={`/post/${post.id}`}
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
                    <Text
                      size="sm"
                      weight="black"
                      style={{
                        color: post.rank <= 3 ? '#FF9800' : tokens.colors.text.tertiary,
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
                        {translatedTitles[`${language}:${post.id}`] || post.title}
                      </Text>
                      {post.view_count !== undefined && post.view_count > 0 && (
                        <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
                          {post.view_count.toLocaleString()} {language === 'en' ? 'views' : '浏览'}
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
    </div>
  )
}
