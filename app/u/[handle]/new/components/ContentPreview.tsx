'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import VideoPlayer, { parseVideoUrl } from './VideoPlayer'

/**
 * Renders post content with edit controls (move / remove) for embedded images.
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

  // No images - just process links
  if (imageMatches.length === 0) {
    const linkParts = text.split(urlRegex)
    return linkParts.map((part, index) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0
        const video = parseVideoUrl(part)
        if (video) {
          return <VideoPlayer key={index} embedUrl={video.embedUrl} type={video.type} />
        }
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
  type ContentPart = {
    type: 'text' | 'image' | 'link' | 'video'
    content: string
    url?: string
    video?: { embedUrl: string; type: string }
    imageIndex?: number
  }

  const parts: ContentPart[] = []
  let currentIndex = 0

  for (const img of imageMatches) {
    if (img.start > currentIndex) {
      const beforeText = text.slice(currentIndex, img.start)
      const linkParts = beforeText.split(urlRegex)
      linkParts.forEach((part) => {
        if (urlRegex.test(part)) {
          urlRegex.lastIndex = 0
          const video = parseVideoUrl(part)
          if (video) {
            parts.push({ type: 'video', content: part, video })
          } else {
            parts.push({ type: 'link', content: part, url: part })
          }
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
        const video = parseVideoUrl(part)
        if (video) {
          parts.push({ type: 'video', content: part, video })
        } else {
          parts.push({ type: 'link', content: part, url: part })
        }
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
              {'\u2191'}
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
              {'\u2193'}
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
              {'\u00d7'}
            </button>
          </div>
        </span>
      )
    }
    if (part.type === 'video' && part.video) {
      return <VideoPlayer key={index} embedUrl={part.video.embedUrl} type={part.video.type} />
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
