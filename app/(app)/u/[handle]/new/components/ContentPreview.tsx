'use client'

import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import {
  findMarkdownImageTokens,
  findMarkdownVideoTokens,
  findRawContentUrlTokens,
} from '@/lib/posts/markdown-images'
import { isAllowedContentImageUrl, linkifyTagsAndMentions } from '@/lib/utils/content'
import VideoPlayer, { parseVideoMarkerUrl, parseVideoUrl } from './VideoPlayer'

/**
 * Renders post content with edit controls (move / remove) for embedded images.
 * Used in preview mode of the post editor.
 */
export function renderContentWithControls(
  text: string,
  onMoveImage: (url: string, direction: 'up' | 'down') => void,
  onRemoveImage: (url: string) => void,
  t: (key: string) => string
) {
  if (!text) return null

  // Keep invalid image tokens in the structural range list so nested media
  // syntax cannot escape an outer rejected token and render independently.
  const imageTokens: {
    start: number
    end: number
    raw: string
    alt: string
    url: string
    imageIndex: number | null
  }[] = []
  let imgIdx = 0
  for (const token of findMarkdownImageTokens(text)) {
    const renderable = isAllowedContentImageUrl(token.url)
    imageTokens.push({
      start: token.start,
      end: token.end,
      raw: token.raw,
      alt: token.alt,
      url: token.url,
      imageIndex: renderable ? imgIdx++ : null,
    })
  }

  type MediaMatch =
    | ({ kind: 'image' } & (typeof imageTokens)[number])
    | {
        kind: 'video'
        start: number
        end: number
        raw: string
        video: ReturnType<typeof parseVideoMarkerUrl>
      }
  const mediaMatches: MediaMatch[] = [
    ...imageTokens.map((image) => ({ kind: 'image' as const, ...image })),
    ...findMarkdownVideoTokens(text).map((token) => ({
      kind: 'video' as const,
      start: token.start,
      end: token.end,
      raw: token.raw,
      video: isAllowedContentImageUrl(token.url) ? parseVideoMarkerUrl(token.url) : null,
    })),
  ].sort((left, right) => left.start - right.start)

  // Build content fragments
  type ContentPart = {
    type: 'text' | 'image' | 'link' | 'video'
    content: string
    url?: string
    video?: NonNullable<ReturnType<typeof parseVideoMarkerUrl>>
    imageIndex?: number
  }

  const parts: ContentPart[] = []
  const appendTextWithLinks = (value: string): void => {
    let rawStart = 0
    for (const token of findRawContentUrlTokens(value)) {
      if (token.start > rawStart) {
        parts.push({ type: 'text', content: value.slice(rawStart, token.start) })
      }

      const video = parseVideoUrl(token.url)
      if (video) {
        parts.push({ type: 'video', content: token.url, video })
      } else {
        parts.push({ type: 'link', content: token.url, url: token.url })
      }
      rawStart = token.end
    }

    if (rawStart < value.length) {
      parts.push({ type: 'text', content: value.slice(rawStart) })
    }
  }
  let currentIndex = 0

  for (const match of mediaMatches) {
    if (match.start < currentIndex) continue
    if (match.start > currentIndex) {
      appendTextWithLinks(text.slice(currentIndex, match.start))
    }
    if (match.kind === 'image' && match.imageIndex !== null) {
      parts.push({
        type: 'image',
        content: match.alt,
        url: match.url,
        imageIndex: match.imageIndex,
      })
    } else if (match.kind === 'image') {
      parts.push({ type: 'text', content: match.raw })
    } else if (match.video) {
      parts.push({ type: 'video', content: match.raw, video: match.video })
    } else {
      parts.push({ type: 'text', content: match.raw })
    }
    currentIndex = match.end
  }

  if (currentIndex < text.length) {
    appendTextWithLinks(text.slice(currentIndex))
  }

  return parts.map((part, index) => {
    if (part.type === 'image') {
      const isFirst = part.imageIndex === 0
      const isLast = part.imageIndex === imgIdx - 1
      return (
        <span
          key={index}
          style={{ position: 'relative', display: 'inline-block', margin: '4px 6px' }}
        >
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
              const openedWindow = window.open(part.url, '_blank', 'noopener,noreferrer')
              if (openedWindow) openedWindow.opener = null
            }}
            unoptimized
          />
          {/* Image control bar */}
          <div
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              display: 'flex',
              gap: 4,
              background: 'var(--color-backdrop-medium)',
              borderRadius: 6,
              padding: '2px 4px',
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation()
                onMoveImage(part.url!, 'up')
              }}
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
              onClick={(e) => {
                e.stopPropagation()
                onMoveImage(part.url!, 'down')
              }}
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
            <button
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation()
                onRemoveImage(part.url!)
              }}
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
    return <span key={index}>{linkifyTagsAndMentions(part.content, `t${index}`)}</span>
  })
}
