'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'

/**
 * Renders post content with inline image controls (move up/down, remove).
 * Used in preview mode of the post editor.
 */
export function renderContentWithControls(
  text: string,
  onMoveImage: (url: string, direction: 'up' | 'down') => void,
  onRemoveImage: (url: string) => void,
  imageCount: number,
  t: (key: string) => string
) {
  if (!text) return null

  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g

  // Find all images
  const imageMatches: { start: number; end: number; alt: string; url: string; imageIndex: number }[] = []
  let match
  let imgIdx = 0
  while ((match = imageRegex.exec(text)) !== null) {
    imageMatches.push({
      start: match.index,
      end: match.index + match[0].length,
      alt: match[1],
      url: match[2],
      imageIndex: imgIdx++,
    })
  }

  // If no images, process links only
  if (imageMatches.length === 0) {
    const linkParts = text.split(urlRegex)
    return linkParts.map((part, index) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              color: tokens.colors.accent.brand,
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

  // Build content fragments
  const parts: { type: 'text' | 'image' | 'link'; content: string; url?: string; imageIndex?: number }[] = []
  let currentIndex = 0

  for (const img of imageMatches) {
    if (img.start > currentIndex) {
      const beforeText = text.slice(currentIndex, img.start)
      const linkParts = beforeText.split(urlRegex)
      linkParts.forEach((part) => {
        if (urlRegex.test(part)) {
          urlRegex.lastIndex = 0
          parts.push({ type: 'link', content: part, url: part })
        } else if (part) {
          parts.push({ type: 'text', content: part })
        }
      })
    }
    parts.push({ type: 'image', content: img.alt, url: img.url, imageIndex: img.imageIndex })
    currentIndex = img.end
  }

  if (currentIndex < text.length) {
    const afterText = text.slice(currentIndex)
    const linkParts = afterText.split(urlRegex)
    linkParts.forEach((part) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        parts.push({ type: 'link', content: part, url: part })
      } else if (part) {
        parts.push({ type: 'text', content: part })
      }
    })
  }

  return parts.map((part, index) => {
    if (part.type === 'image') {
      const isFirst = part.imageIndex === 0
      const isLast = part.imageIndex === imageCount - 1
      return (
        <span key={index} style={{ position: 'relative', display: 'inline-block', margin: '4px 6px' }}>
          <Image
            src={part.url || ''}
            alt={part.content || 'image'}
            width={400}
            height={300}
            style={{
              maxWidth: '100%',
              maxHeight: 300,
              borderRadius: tokens.radius.md,
              cursor: 'pointer',
              display: 'block',
              objectFit: 'contain',
            }}
            onClick={(e) => {
              e.stopPropagation()
              window.open(part.url, '_blank')
            }}
            unoptimized
          />
          {/* Image control bar */}
          <div style={{
            position: 'absolute',
            top: 4,
            right: 4,
            display: 'flex',
            gap: 4,
            background: 'var(--color-backdrop-medium)',
            borderRadius: 6,
            padding: '2px 4px',
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); onMoveImage(part.url!, 'up') }}
              disabled={isFirst}
              title={t('moveUp')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: isFirst ? 'var(--color-overlay-dark)' : 'var(--color-accent-primary)',
                color: tokens.colors.white,
                cursor: isFirst ? 'not-allowed' : 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↑
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onMoveImage(part.url!, 'down') }}
              disabled={isLast}
              title={t('moveDown')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: isLast ? 'var(--color-overlay-dark)' : 'var(--color-accent-primary)',
                color: tokens.colors.white,
                cursor: isLast ? 'not-allowed' : 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ↓
            </button>
            <button aria-label="Close"
              onClick={(e) => { e.stopPropagation(); onRemoveImage(part.url!) }}
              title={t('remove')}
              style={{
                width: 24,
                height: 24,
                border: 'none',
                background: 'var(--color-accent-error)',
                color: tokens.colors.white,
                cursor: 'pointer',
                fontSize: 14,
                borderRadius: tokens.radius.sm,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              ×
            </button>
          </div>
        </span>
      )
    }
    if (part.type === 'link') {
      return (
        <a
          key={index}
          href={part.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{
            color: tokens.colors.accent.brand,
            textDecoration: 'underline',
            wordBreak: 'break-all',
          }}
        >
          {part.content}
        </a>
      )
    }
    return <span key={index}>{part.content}</span>
  })
}

interface ContentPreviewPanelProps {
  content: string
  moveImageInContent: (url: string, direction: 'up' | 'down') => void
  removeImageFromContent: (url: string) => void
  t: (key: string) => string
}

/**
 * The preview panel wrapper that renders content with image controls
 * and a "Preview Mode" badge.
 */
export function ContentPreviewPanel({
  content,
  moveImageInContent,
  removeImageFromContent,
  t,
}: ContentPreviewPanelProps) {
  return (
    <Box
      style={{
        width: '100%',
        minHeight: 288,
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.md,
        border: ('2px solid ' + tokens.colors.accent.brand),
        background: `linear-gradient(135deg, var(--color-accent-primary-08) 0%, var(--color-accent-primary-10) 100%)`,
        color: tokens.colors.text.primary,
        fontSize: tokens.typography.fontSize.base,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        position: 'relative',
      }}
    >
      {/* Preview mode label */}
      <Box
        style={{
          position: 'absolute',
          top: -12,
          left: 12,
          background: tokens.colors.accent.brand,
          color: tokens.colors.white,
          padding: '2px 10px',
          borderRadius: tokens.radius.full,
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {t('previewMode')}
      </Box>
      {content ? renderContentWithControls(
        content,
        moveImageInContent,
        removeImageFromContent,
        (content.match(/!\[image\]\([^)]+\)/g) || []).length,
        t
      ) : <Text color="tertiary">{t('previewPlaceholder')}</Text>}
    </Box>
  )
}
