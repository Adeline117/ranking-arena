'use client'

import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import ClaimTraderButton from './ClaimTraderButton'
import { supabase } from '@/lib/supabase/client'
import type { TraderFeedItem } from '@/lib/data/trader'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface TraderFeedProps {
  items: TraderFeedItem[]
  title: string
  showPostButton?: boolean
  onPostClick?: () => void
  isRegistered?: boolean
  traderId?: string
  traderHandle?: string
  source?: string
}

type SortType = 'all' | 'top'

function cleanContent(text: string, maxLength = 140): string {
  if (!text) return ''
  const stripped = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '').trim()
  return stripped.length > maxLength ? stripped.slice(0, maxLength) + '...' : stripped
}

function getFeedItemHref(item: TraderFeedItem): string {
  const postId = item.type === 'repost' && item.original_post_id
    ? item.original_post_id
    : item.id
  return item.groupId ? `/groups/${item.groupId}` : `/posts/${postId}`
}

function formatRelativeTime(dateString: string, language: string, t: (key: string) => string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)

  if (hours < 1) return t('justNow')
  if (hours < 24) return t('hoursAgoShort').replace('{n}', String(hours))
  if (days < 7) return t('daysAgoShort').replace('{n}', String(days))
  return date.toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' })
}

export default function TraderFeed({ items, title, showPostButton = false, onPostClick, isRegistered, traderId, traderHandle, source }: TraderFeedProps) {
  const [sortType, setSortType] = useState<SortType>('all')
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const { t, language } = useLanguage()

  useEffect(() => {
     
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null)
    }).catch(() => { /* Auth check non-critical for trader feed */ })
  }, [])

  const sortedItems = useMemo(() => {
    let sorted: TraderFeedItem[]
    
    if (sortType === 'top') {
      sorted = [...items].sort((a, b) => (b.like_count || 0) - (a.like_count || 0))
    } else {
      sorted = [...items].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    }
    
    return sorted.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1
      if (!a.is_pinned && b.is_pinned) return 1
      return 0
    })
  }, [items, sortType])

  return (
    <Box
      className="feed-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        overflow: 'hidden',
        boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
      }}
    >
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: tokens.spacing[5],
          borderBottom: `1px solid ${tokens.colors.border.primary}40`,
          background: `linear-gradient(180deg, ${tokens.colors.bg.secondary} 0%, transparent 100%)`,
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            {title}
          </Text>
          <Box
            style={{
              background: `${tokens.colors.accent.primary}20`,
              padding: `2px ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.full,
            }}
          >
            <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary }}>
              {items.length}
            </Text>
          </Box>
        </Box>
        
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* Sort Buttons */}
          <Box
            style={{
              display: 'flex',
              gap: 2,
              background: tokens.colors.bg.tertiary,
              padding: 2,
              borderRadius: tokens.radius.md,
            }}
          >
            {(['all', 'top'] as SortType[]).map((type) => (
              <button
                key={type}
                onClick={() => setSortType(type)}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.sm,
                  border: 'none',
                  background: sortType === type ? tokens.colors.bg.primary : 'transparent',
                  color: sortType === type ? tokens.colors.text.primary : tokens.colors.text.tertiary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: sortType === type ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  textTransform: 'capitalize',
                }}
              >
                {type === 'all' ? t('sortLatest') : t('sortHot')}
              </button>
            ))}
          </Box>
          
          {/* Post Button */}
          {showPostButton && onPostClick && (
            <button
              onClick={onPostClick}
              className="ripple-effect"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.lg,
                border: 'none',
                background: `linear-gradient(135deg, ${tokens.colors.accent.brand}, ${tokens.colors.accent.primary})`,
                color: tokens.colors.white,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.black,
                cursor: 'pointer',
                transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: `0 4px 12px ${tokens.colors.accent.brand}40`,
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-2px)'
                e.currentTarget.style.boxShadow = `0 6px 20px ${tokens.colors.accent.brand}50`
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
                e.currentTarget.style.boxShadow = `0 4px 12px ${tokens.colors.accent.brand}40`
              }}
            >
              {t('newPost')}
            </button>
          )}
        </Box>
      </Box>

      {/* 交易员未入驻提示 */}
      {isRegistered === false ? (
        <Box
          style={{
            padding: tokens.spacing[10],
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
          <Text size="base" weight="bold" style={{ color: tokens.colors.text.secondary }}>
            {t('traderNotRegistered')}
          </Text>
          <Text size="sm" color="tertiary">
            {t('traderNotRegisteredDesc')}
          </Text>
          {userId && traderId && traderHandle && (
            <Box style={{ marginTop: tokens.spacing[2] }}>
              <ClaimTraderButton
                traderId={traderId}
                handle={traderHandle}
                userId={userId}
                source={source}
              />
            </Box>
          )}
        </Box>
      ) : items.length === 0 ? (
        <Box
          style={{
            padding: tokens.spacing[10],
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: tokens.spacing[3],
          }}
        >
          <Text size="base" color="tertiary">
            {t('noData')}
          </Text>
          {showPostButton && onPostClick && (
            <Text size="sm" color="tertiary">
              {t('postFirstUpdate')}
            </Text>
          )}
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column' }}>
          {sortedItems.map((item, idx) => (
            <Link
              key={item.id}
              href={getFeedItemHref(item)}
              style={{ textDecoration: 'none' }}
              onMouseEnter={() => setHoveredId(item.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <Box
                className="feed-item"
                style={{
                  padding: tokens.spacing[5],
                  background: hoveredId === item.id ? `${tokens.colors.accent.primary}05` : 'transparent',
                  borderBottom: idx < sortedItems.length - 1 ? `1px solid ${tokens.colors.border.primary}30` : 'none',
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  transform: hoveredId === item.id ? 'translateX(6px)' : 'translateX(0)',
                  borderLeft: hoveredId === item.id 
                    ? `3px solid ${tokens.colors.accent.primary}` 
                    : '3px solid transparent',
                }}
              >
                {/* Repost Badge */}
                {item.type === 'repost' && (
                  <Box
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: tokens.spacing[1],
                      marginBottom: tokens.spacing[2],
                      padding: `2px ${tokens.spacing[2]}`,
                      background: `${tokens.colors.accent.primary}10`,
                      borderRadius: tokens.radius.full,
                    }}
                  >
                    <Text size="xs" color="tertiary">
                      {t('repostFromLabel')}{' '}
                      <Link
                        href={`/u/${encodeURIComponent(item.original_author_handle || '')}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: tokens.colors.accent.primary, textDecoration: 'none', fontWeight: 600 }}
                      >
                        @{item.original_author_handle}
                      </Link>
                    </Text>
                  </Box>
                )}
                
                {/* Repost Comment */}
                {item.type === 'repost' && item.repost_comment && (
                  <Box
                    style={{
                      marginBottom: tokens.spacing[3],
                      padding: tokens.spacing[3],
                      background: `linear-gradient(135deg, ${tokens.colors.bg.secondary}80, ${tokens.colors.bg.tertiary}40)`,
                      borderRadius: tokens.radius.lg,
                      borderLeft: `3px solid ${tokens.colors.accent.primary}60`,
                    }}
                  >
                    <Text size="sm" color="secondary" style={{ fontStyle: 'italic' }}>
                      &ldquo;{item.repost_comment}&rdquo;
                    </Text>
                  </Box>
                )}

                {/* Title Row */}
                <Box
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: tokens.spacing[2],
                    gap: tokens.spacing[3],
                  }}
                >
                  <Box style={{ flex: 1, display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
                    {/* Pinned Badge */}
                    {item.is_pinned && (
                      <Box
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: `2px ${tokens.spacing[2]}`,
                          background: `linear-gradient(135deg, ${tokens.colors.accent.warning}20, ${tokens.colors.accent.warning}10)`,
                          borderRadius: tokens.radius.full,
                          border: `1px solid ${tokens.colors.accent.warning}30`,
                        }}
                      >
                        <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.warning }}>
                          {t('pinnedLabel')}
                        </Text>
                      </Box>
                    )}
                    <Text
                      size="base"
                      weight="bold"
                      style={{
                        color: tokens.colors.text.primary,
                        lineHeight: 1.4,
                      }}
                    >
                      {item.title}
                    </Text>
                  </Box>
                  
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexShrink: 0 }}>
                    {item.like_count !== undefined && item.like_count > 0 && (
                      <Box
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          padding: `2px ${tokens.spacing[2]}`,
                          background: `${tokens.colors.accent.error}10`,
                          borderRadius: tokens.radius.full,
                        }}
                      >
                        <Text size="xs" weight="medium" style={{ color: tokens.colors.accent.error }}>
                          {item.like_count}
                        </Text>
                      </Box>
                    )}
                    <Text size="xs" color="tertiary">
                      {formatRelativeTime(item.time, language, t)}
                    </Text>
                  </Box>
                </Box>
                
                {/* Content Preview */}
                {item.content && (
                  <Text
                    size="sm"
                    color="secondary"
                    style={{
                      lineHeight: 1.6,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {cleanContent(item.content)}
                  </Text>
                )}
                
                {/* Group Link */}
                {item.groupId && item.groupName && (
                  <Link
                    href={`/groups/${item.groupId}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      marginTop: tokens.spacing[3],
                      padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                      background: `${tokens.colors.accent.primary}08`,
                      borderRadius: tokens.radius.md,
                      textDecoration: 'none',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <Text size="xs" weight="medium" style={{ color: tokens.colors.accent.primary }}>
                      {item.groupName}
                    </Text>
                  </Link>
                )}
              </Box>
            </Link>
          ))}
        </Box>
      )}
    </Box>
  )
}
