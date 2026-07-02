'use client'

/**
 * SharedPostContent — unified post content renderer.
 *
 * Extracts the common visual elements that MUST be consistent across:
 *   - PostFeed (main feed, user profiles)
 *   - Hot page cards
 *   - Group posts
 *   - Post detail modal
 *
 * Handles: title, body, images, author info, timestamp, tags.
 * Does NOT handle: action buttons, comments, editing (context-specific).
 */

import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { formatTimeAgo, type Locale } from '@/lib/utils/date'
import { ARENA_PURPLE, renderContentWithLinks, truncateText } from '@/lib/utils/content'
import { localizedLabel } from '@/lib/utils/format'
import { t } from '@/lib/i18n'
import { resolveUserDisplayName } from '@/lib/utils/user-display'

export interface PostContentData {
  id: string
  title?: string | null
  content?: string | null
  author_handle?: string | null
  author_avatar_url?: string | null
  author_display_name?: string | null
  group_id?: string | null
  group_name?: string | null
  group_name_en?: string | null
  created_at?: string | null
  images?: string[] | null
  poll_id?: string | null
  is_pinned?: boolean
}

export interface PostContentProps {
  post: PostContentData
  language: Locale
  /** Max characters before truncation (default: 150) */
  maxChars?: number
  /** Max lines for content clamp (default: 2) */
  maxLines?: number
  /** Show images (default: true) */
  showImages?: boolean
  /** Show group link (default: true) */
  showGroup?: boolean
  /** Translated title/body overrides */
  translatedTitle?: string
  translatedBody?: string
  /** i18n function */
  t: (key: string) => string
}

/**
 * Renders post content consistently across all contexts.
 * Only handles display — no click handlers, no action buttons.
 */
export function PostContent({
  post: p,
  language,
  maxChars = 150,
  maxLines = 2,
  showImages = true,
  showGroup = true,
  translatedTitle,
  translatedBody,
  t,
}: PostContentProps) {
  const displayTitle = translatedTitle || (p.title && p.title !== 'Untitled' ? p.title : '')
  const displayContent = translatedBody || p.content || ''
  const hasImages = showImages && p.images && p.images.length > 0

  return (
    <>
      {/* Row 1: Group badge + Author + Timestamp */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          flexWrap: 'nowrap',
          minWidth: 0,
        }}
      >
        {showGroup && p.group_id && p.group_name && (
          <Link
            href={`/groups/${p.group_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              color: ARENA_PURPLE,
              textDecoration: 'none',
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flexShrink: 1,
              minWidth: 0,
            }}
          >
            {localizedLabel(p.group_name, p.group_name_en || p.group_name, language)}
          </Link>
        )}
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {p.author_avatar_url && (
            <img
              src={p.author_avatar_url}
              alt=""
              width={18}
              height={18}
              style={{ borderRadius: '50%', objectFit: 'cover' }}
            />
          )}
          {(() => {
            const name = resolveUserDisplayName(
              { handle: p.author_handle, displayName: p.author_display_name },
              t
            )
            return name.linkHandle ? (
              <Link
                href={`/u/${encodeURIComponent(name.linkHandle)}`}
                onClick={(e) => e.stopPropagation()}
                style={{
                  color: 'var(--color-text-secondary)',
                  textDecoration: 'none',
                  fontWeight: 700,
                }}
              >
                @{name.label}
              </Link>
            ) : (
              <span style={{ color: 'var(--color-text-tertiary)' }}>{name.label}</span>
            )
          })()}
        </span>
        {p.created_at && (
          <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0 }}>
            · {formatTimeAgo(p.created_at, language)}
          </span>
        )}
        {p.is_pinned && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: ARENA_PURPLE,
              background: 'var(--color-accent-primary-10)',
              padding: '1px 6px',
              borderRadius: tokens.radius.sm,
              flexShrink: 0,
            }}
          >
            PIN
          </span>
        )}
      </div>

      {/* Row 2: Title */}
      {displayTitle && (
        <div
          style={{
            marginTop: 6,
            fontWeight: 900,
            lineHeight: 1.25,
            color: translatedTitle ? tokens.colors.accent.translated : tokens.colors.text.primary,
          }}
        >
          {displayTitle}
          {p.poll_id && (
            <span
              style={{
                fontSize: 11,
                color: ARENA_PURPLE,
                fontWeight: 700,
                border: `1px solid ${tokens.colors.border.primary}`,
                padding: '2px 8px',
                borderRadius: tokens.radius.full,
                background: 'var(--color-accent-primary-10)',
                marginLeft: 8,
              }}
            >
              {t('poll')}
            </span>
          )}
        </div>
      )}

      {/* Row 3: Content preview */}
      {displayContent && (
        <div
          style={{
            marginTop: 8,
            fontSize: 13,
            color: translatedBody ? tokens.colors.accent.translated : tokens.colors.text.secondary,
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: '-webkit-box',
            WebkitLineClamp: maxLines,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {renderContentWithLinks(truncateText(displayContent, maxChars))}
        </div>
      )}

      {/* Row 4: Images */}
      {hasImages && p.images!.length === 1 && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              width: 200,
              height: 150,
              borderRadius: tokens.radius.md,
              overflow: 'hidden',
              background: tokens.colors.bg.tertiary,
            }}
          >
            <img
              src={p.images![0]}
              alt="Post image"
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
              onError={(e) => {
                ;(e.target as HTMLImageElement).style.display = 'none'
              }}
            />
          </div>
        </div>
      )}
      {hasImages && p.images!.length > 1 && (
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            gap: 8,
            overflowX: 'auto',
            scrollSnapType: 'x mandatory',
            paddingBottom: 4,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {p.images!.map((imgUrl, idx) => (
            <div
              key={idx}
              style={{
                width: 120,
                height: 90,
                borderRadius: tokens.radius.md,
                overflow: 'hidden',
                background: tokens.colors.bg.tertiary,
                flexShrink: 0,
                scrollSnapAlign: 'start',
              }}
            >
              <img
                src={imgUrl}
                alt={`Image ${idx + 1}`}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}
