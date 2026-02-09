'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
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
import type { UnifiedSearchResponse, UnifiedSearchResult } from '@/app/api/search/route'
import { logger } from '@/lib/logger'

/** 高亮搜索关键词 */
function highlightMatch(text: string, q: string): React.ReactNode {
  if (!text || !q.trim()) return text
  const lower = text.toLowerCase()
  const lq = q.toLowerCase().trim()
  const parts: React.ReactNode[] = []
  let last = 0
  let idx = lower.indexOf(lq)
  while (idx !== -1) {
    if (idx > last) parts.push(text.slice(last, idx))
    parts.push(
      <mark key={`hl-${idx}`} style={{
        backgroundColor: 'var(--color-accent-primary-25, rgba(139,92,246,0.25))',
        color: 'inherit', borderRadius: 2, padding: '0 1px', fontWeight: 700,
      }}>
        {text.slice(idx, idx + lq.length)}
      </mark>
    )
    last = idx + lq.length
    idx = lower.indexOf(lq, last)
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts.length > 0 ? parts : text
}

interface SearchDropdownProps {
  open: boolean
  query: string
  onClose: () => void
}

interface HotPost {
  id: string
  title: string
  hotScore: number
  rank: number
  view_count?: number
}

// 类别配置
const CATEGORY_CONFIG = {
  traders: { icon: 'T', labelZh: '交易员', labelEn: 'Traders', color: '#8B5CF6' },
  posts: { icon: 'P', labelZh: '帖子', labelEn: 'Posts', color: '#3B82F6' },
  library: { icon: 'L', labelZh: '资料库', labelEn: 'Library', color: '#10B981' },
  users: { icon: 'U', labelZh: '用户', labelEn: 'Users', color: '#F59E0B' },
} as const

type CategoryKey = keyof typeof CATEGORY_CONFIG

/**
 * 搜索下拉菜单
 * - 统一搜索：交易员、帖子、资料库、用户
 * - 按类别分组显示结果
 * - 键盘导航（上下箭头、Enter、Escape）
 * - 搜索历史记录
 * - 热榜帖子
 */
export default function SearchDropdown({ open, query, onClose }: SearchDropdownProps) {
  const router = useRouter()
  const { t, language } = useLanguage()
  const { userId, isLoggedIn, authChecked } = useAuthSession()
  const [searchHistory, setSearchHistory] = useState<string[]>([])
  const [hotPosts, setHotPosts] = useState<HotPost[]>([])
  const [loading, setLoading] = useState(false)
  const [searchData, setSearchData] = useState<UnifiedSearchResponse | null>(null)
  const [searching, setSearching] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [translatedTitles, setTranslatedTitles] = useState<Record<string, string>>({})
  const [translating, setTranslating] = useState(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 展平所有结果用于键盘导航
  const flatResults: UnifiedSearchResult[] = searchData
    ? [
        ...searchData.results.traders,
        ...searchData.results.posts,
        ...searchData.results.library,
        ...searchData.results.users,
      ]
    : []

  // 加载搜索历史
  useEffect(() => {
    if (!authChecked) return
    const loadHistory = async () => {
      const history = await initializeHistory(userId ?? undefined)
      setSearchHistory(history)
    }
    loadHistory()
  }, [authChecked, userId, isLoggedIn])

  // 加载热榜帖子
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

      if (error) return

      if (data && data.length > 0) {
        setHotPosts(
          data.map((post, index) => ({
            id: post.id,
            title: post.title || t('noTitle'),
            hotScore:
              post.hot_score ||
              (post.view_count || 0) * 0.1 +
                (post.like_count || 0) * 2 +
                (post.comment_count || 0) * 3,
            rank: index + 1,
            view_count: post.view_count,
          }))
        )
      }
    } catch (e) {
      logger.error('Failed to load hot posts:', e)
    } finally {
      setLoading(false)
    }
  }, [open])

  useEffect(() => {
    loadHotPosts()
  }, [loadHotPosts])

  // 热榜标题翻译
  useEffect(() => {
    if (hotPosts.length === 0 || translating) return

    const langKey = (id: string) => `${language}:${id}`
    const needsTranslation = hotPosts.some(
      (post) => !translatedTitles[langKey(post.id)]
    )
    if (!needsTranslation) return

    const isCJK = (text: string) => /[\u4e00-\u9fff\u3000-\u303f]/.test(text)
    const postsToTranslate = hotPosts.filter((post) => {
      if (translatedTitles[langKey(post.id)]) return false
      const titleIsCJK = isCJK(post.title)
      if (language === 'zh' && titleIsCJK) return false
      if (language === 'en' && !titleIsCJK) return false
      return true
    })

    if (postsToTranslate.length === 0) {
      const newTranslations = { ...translatedTitles }
      hotPosts.forEach((post) => {
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
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: postsToTranslate.map((p) => ({
              id: p.id,
              text: p.title,
              contentType: 'post_title',
              contentId: p.id,
            })),
            targetLang: language === 'zh' ? 'zh' : 'en',
          }),
        })
        if (res.ok) {
          const json = await res.json()
          const results = json.data?.results || {}
          const newTranslations: Record<string, string> = { ...translatedTitles }
          postsToTranslate.forEach((post) => {
            if (results[post.id]?.translatedText) {
              newTranslations[langKey(post.id)] = results[post.id].translatedText
            }
          })
          hotPosts.forEach((post) => {
            if (!newTranslations[langKey(post.id)]) {
              newTranslations[langKey(post.id)] = post.title
            }
          })
          setTranslatedTitles(newTranslations)
        }
      } catch (e) {
        logger.error('Failed to translate hot posts:', e)
      } finally {
        setTranslating(false)
      }
    }
    translateTitles()
  }, [language, hotPosts, translatedTitles, translating])

  // 统一搜索 - 300ms 防抖
  useEffect(() => {
    if (!open || !query.trim() || query.length < 2) {
      setSearchData(null)
      setSelectedIndex(-1)
      return
    }

    const searchTimer = setTimeout(async () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      const controller = new AbortController()
      abortControllerRef.current = controller
      setSearching(true)

      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}&limit=5`,
          { signal: controller.signal }
        )

        if (!response.ok) throw new Error('Search failed')

        const json = await response.json()
        const data: UnifiedSearchResponse = json.data || json

        if (!controller.signal.aborted) {
          setSearchData(data)
          setSelectedIndex(-1)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        logger.error('Search error:', error)
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false)
        }
      }
    }, 300)

    return () => {
      clearTimeout(searchTimer)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
    }
  }, [query, open])

  // 保存搜索历史
  const saveToHistory = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim()) return
      const newHistory = await addToHistory(searchQuery, userId ?? undefined)
      setSearchHistory(newHistory)
    },
    [userId]
  )

  // 键盘导航
  useEffect(() => {
    if (!open) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (flatResults.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((prev) =>
          prev < flatResults.length - 1 ? prev + 1 : 0
        )
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((prev) =>
          prev > 0 ? prev - 1 : flatResults.length - 1
        )
      } else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault()
        const selected = flatResults[selectedIndex]
        if (selected) {
          saveToHistory(query)
          router.push(selected.href)
          onClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatResults, selectedIndex, query, onClose, router, saveToHistory])

  // 删除历史记录
  const handleDeleteHistory = async (term: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const newHistory = await removeFromHistory(term, userId ?? undefined)
    setSearchHistory(newHistory)
  }

  const handleClearAllHistory = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    await clearHistory(userId ?? undefined)
    setSearchHistory([])
  }

  const handleResultClick = () => {
    if (query.trim()) {
      saveToHistory(query)
    }
    onClose()
  }

  if (!open) return null

  // 计算展平索引偏移，用于高亮
  const getCategoryOffset = (category: CategoryKey): number => {
    if (!searchData) return 0
    const order: CategoryKey[] = ['traders', 'posts', 'library', 'users']
    let offset = 0
    for (const key of order) {
      if (key === category) break
      offset += searchData.results[key].length
    }
    return offset
  }

  const renderCategoryResults = (
    category: CategoryKey,
    items: UnifiedSearchResult[]
  ) => {
    if (items.length === 0) return null
    const config = CATEGORY_CONFIG[category]
    const offset = getCategoryOffset(category)
    const label = language === 'zh' ? config.labelZh : config.labelEn

    return (
      <Box key={category}>
        {/* 类别标题 */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Box
            style={{
              width: 20,
              height: 20,
              borderRadius: tokens.radius.sm,
              background: `${config.color}20`,
              color: config.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            {config.icon}
          </Box>
          <Text
            size="xs"
            weight="bold"
            color="tertiary"
            style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}
          >
            {label}
          </Text>
          <Text size="xs" color="tertiary">
            ({items.length})
          </Text>
        </Box>

        {/* 结果列表 */}
        {items.map((result, index) => {
          const globalIndex = offset + index
          const isSelected = globalIndex === selectedIndex
          return (
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
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  borderBottom: `1px solid ${tokens.colors.border.primary}`,
                  cursor: 'pointer',
                  background: isSelected
                    ? tokens.colors.bg.tertiary
                    : 'transparent',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => {
                  setSelectedIndex(globalIndex)
                  e.currentTarget.style.background = tokens.colors.bg.tertiary
                }}
                onMouseLeave={(e) => {
                  if (globalIndex !== selectedIndex) {
                    e.currentTarget.style.background = 'transparent'
                  }
                }}
              >
                {/* 用户头像或类型图标 */}
                {result.avatar ? (
                  <Image
                    src={result.avatar}
                    alt={result.title || 'Avatar'}
                    width={28}
                    height={28}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: tokens.radius.full,
                      objectFit: 'cover',
                      flexShrink: 0,
                    }}
                    unoptimized={result.avatar.startsWith('data:')}
                  />
                ) : (
                  <Box
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: tokens.radius.full,
                      background: `${config.color}15`,
                      color: config.color,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 12,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {config.icon}
                  </Box>
                )}
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    size="sm"
                    style={{
                      color: tokens.colors.text.primary,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {highlightMatch(result.title, query)}
                  </Text>
                  {result.subtitle && (
                    <Text
                      size="xs"
                      color="tertiary"
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {highlightMatch(result.subtitle, query)}
                    </Text>
                  )}
                </Box>
                {/* 键盘导航提示 */}
                {isSelected && (
                  <Text
                    size="xs"
                    color="tertiary"
                    style={{ flexShrink: 0, opacity: 0.5 }}
                  >
                    Enter
                  </Text>
                )}
              </Box>
            </Link>
          )
        })}
      </Box>
    )
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
        WebkitOverflowScrolling: 'touch',
        zIndex: tokens.zIndex.dropdown,
        boxShadow: tokens.shadow.md,
      }}
    >
      {/* 搜索结果 - 按类别分组 */}
      {query.trim().length >= 2 && (
        <Box>
          {searching ? (
            <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
              {[1, 2, 3, 4].map((i) => (
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
                      width: 28,
                      height: 28,
                      borderRadius: tokens.radius.full,
                      background: tokens.colors.bg.tertiary,
                      animation: 'pulse 1.5s ease-in-out infinite',
                      flexShrink: 0,
                    }}
                  />
                  <Box
                    style={{
                      flex: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <Box
                      style={{
                        width: `${50 + i * 12}%`,
                        height: 12,
                        background: tokens.colors.bg.tertiary,
                        borderRadius: tokens.radius.sm,
                        animation: 'pulse 1.5s ease-in-out infinite',
                      }}
                    />
                    <Box
                      style={{
                        width: `${30 + i * 8}%`,
                        height: 10,
                        background: tokens.colors.bg.tertiary,
                        borderRadius: tokens.radius.sm,
                        animation: 'pulse 1.5s ease-in-out infinite',
                        opacity: 0.6,
                      }}
                    />
                  </Box>
                </Box>
              ))}
            </Box>
          ) : searchData && searchData.total === 0 ? (
            <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
              <Text size="sm" color="tertiary">
                {t('noRelatedResults')}
              </Text>
            </Box>
          ) : searchData ? (
            <>
              {renderCategoryResults('traders', searchData.results.traders)}
              {renderCategoryResults('posts', searchData.results.posts)}
              {renderCategoryResults('library', searchData.results.library)}
              {renderCategoryResults('users', searchData.results.users)}

              {/* 查看全部 */}
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
                    {t('viewAllSearchResults')} →
                  </Text>
                </Box>
              </Link>
            </>
          ) : null}
        </Box>
      )}

      {/* 搜索历史 */}
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
            <Text
              size="xs"
              weight="bold"
              color="tertiary"
              style={{ textTransform: 'uppercase' }}
            >
              {t('searchHistory')}
            </Text>
            <button
              onClick={handleClearAllHistory}
              aria-label={t('clearSearchHistory')}
              style={{
                background: 'transparent',
                border: 'none',
                color: tokens.colors.text.tertiary,
                cursor: 'pointer',
                fontSize: tokens.typography.fontSize.xs,
                padding: 0,
              }}
            >
              {t('clearSearchHistory')}
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
                  <Text
                    size="sm"
                    style={{ color: tokens.colors.text.primary }}
                  >
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

      {/* 热榜帖子 */}
      {query.trim().length < 2 && (
        <Box>
          <Box
            style={{
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderBottom:
                searchHistory.length > 0
                  ? `1px solid ${tokens.colors.border.primary}`
                  : 'none',
            }}
          >
            <Text
              size="xs"
              weight="bold"
              color="tertiary"
              style={{ textTransform: 'uppercase' }}
            >
              {t('hotPosts')}
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
              <Box
                style={{ padding: tokens.spacing[4], textAlign: 'center' }}
              >
                <Text size="sm" color="tertiary">
                  {t('noHotPosts')}
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
                      e.currentTarget.style.background =
                        tokens.colors.bg.tertiary
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <Text
                      size="sm"
                      weight="black"
                      style={{
                        color:
                          post.rank <= 3
                            ? tokens.colors.accent.warning
                            : tokens.colors.text.tertiary,
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
                        {translatedTitles[`${language}:${post.id}`] ||
                          post.title}
                      </Text>
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
