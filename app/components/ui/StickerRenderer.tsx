'use client'

import { createElement, type ReactNode } from 'react'
import { getStickerById, isPureSticker, extractStickerId, STICKER_PATTERN } from '@/lib/stickers'

interface StickerImageProps {
  stickerId: string
  size: number
}

function StickerImage({ stickerId, size }: StickerImageProps) {
  const sticker = getStickerById(stickerId)
  if (!sticker) return createElement('span', null, `[sticker:${stickerId}]`)
  return createElement('img', {
    src: sticker.path,
    alt: sticker.name_en,
    width: size,
    height: size,
    style: { display: 'inline-block', verticalAlign: 'middle', objectFit: 'contain' },
    loading: 'lazy',
  })
}

/**
 * Renders text that may contain [sticker:xxx] patterns.
 * Pure sticker messages render larger. Mixed content renders inline.
 */
export function renderWithStickers(text: string, size: number = 64): ReactNode[] | null {
  if (!text) return null

  // Pure sticker - render big
  if (isPureSticker(text)) {
    const id = extractStickerId(text)
    if (id && getStickerById(id)) {
      return [createElement(StickerImage, { key: 'sticker', stickerId: id, size: Math.max(size, 96) })]
    }
  }

  // Mixed content - split on sticker pattern
  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  STICKER_PATTERN.lastIndex = 0
  while ((match = STICKER_PATTERN.exec(text)) !== null) {
    // Text before sticker
    if (match.index > lastIndex) {
      parts.push(createElement('span', { key: `t${lastIndex}` }, text.slice(lastIndex, match.index)))
    }
    // Sticker
    const stickerId = match[1]
    if (getStickerById(stickerId)) {
      parts.push(createElement(StickerImage, { key: `s${match.index}`, stickerId, size: Math.min(size, 32) }))
    } else {
      parts.push(createElement('span', { key: `u${match.index}` }, match[0]))
    }
    lastIndex = match.index + match[0].length
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(createElement('span', { key: `t${lastIndex}` }, text.slice(lastIndex)))
  }

  return parts.length > 0 ? parts : null
}

/** Check if text contains any sticker pattern */
export function hasStickers(text: string): boolean {
  STICKER_PATTERN.lastIndex = 0
  return STICKER_PATTERN.test(text)
}
