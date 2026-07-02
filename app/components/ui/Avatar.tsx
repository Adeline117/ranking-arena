'use client'

import { useState, type ReactElement } from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import {
  getAvatarGradient,
  getAvatarInitial,
  getUserAvatarUrl,
  getTraderAvatarUrl,
  needsProxy,
  type AvatarProps,
} from '@/lib/utils/avatar'
import { isSvgAvatarSource } from '@/lib/utils/avatar-proxy'

function resolveAvatarUrl(
  isTrader: boolean,
  avatarUrl: string | null | undefined,
  userId: string,
  name?: string | null,
  avatarMirrorUrl?: string | null
): string | null {
  if (isTrader) {
    // Prefer our own CDN mirror (direct-load supabase URL, no proxy, no 429).
    const mirror = avatarMirrorUrl?.trim()
    if (mirror) return mirror
    const resolved = getTraderAvatarUrl(avatarUrl)
    if (resolved) return resolved
    // No generated avatars (dicebear/blockie) — always gradient + initial letter
    return null
  }
  if (avatarUrl?.trim()) return avatarUrl
  if (avatarUrl === null) return null
  return getUserAvatarUrl(userId, null, name ?? null) ?? null
}

export default function Avatar({
  userId,
  name,
  avatarUrl,
  avatarMirrorUrl,
  size = 40,
  className,
  style,
  isTrader = false,
}: AvatarProps): ReactElement {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)

  const initial = getAvatarInitial(name || userId)
  const backgroundGradient = getAvatarGradient(userId)

  const finalAvatarUrl = resolveAvatarUrl(isTrader, avatarUrl, userId, name, avatarMirrorUrl)
  // Data URIs (blockie/identicon SVGs) bypass Next.js Image Optimization — they're already tiny.
  // All other images go through /_next/image for resize + webp conversion (749KB → ~5KB).
  const _isDataUri = !!finalAvatarUrl?.startsWith('data:')

  const showDefault = imageError || !finalAvatarUrl

  return (
    <Box
      className={`${className || ''}`}
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
        background: showDefault ? backgroundGradient : tokens.colors.bg.secondary,
        display: 'grid',
        placeItems: 'center',
        transition: tokens.transition.base,
        boxShadow: tokens.shadow.sm,
        ...style,
      }}
    >
      {!showDefault && finalAvatarUrl ? (
        <>
          {imageLoading && (
            <Box
              style={{
                position: 'absolute',
                inset: 0,
                background: backgroundGradient,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <Text
                size="sm"
                weight="black"
                style={{
                  color: tokens.colors.white,
                  fontSize: size * 0.4,
                }}
              >
                {initial}
              </Text>
            </Box>
          )}
          <Image
            src={
              needsProxy(finalAvatarUrl)
                ? `/api/avatar?url=${encodeURIComponent(finalAvatarUrl)}`
                : finalAvatarUrl
            }
            alt={name || userId || 'Avatar'}
            width={size}
            height={size}
            sizes={`${size}px`}
            // data: URIs and SVG sources (dicebear etc.) must bypass /_next/image —
            // the optimizer 400s on SVG (dangerouslyAllowSVG: false).
            unoptimized={finalAvatarUrl.startsWith('data:') || isSvgAvatarSource(finalAvatarUrl)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: imageLoading ? 'none' : 'block',
            }}
            onLoad={() => {
              setImageLoading(false)
            }}
            onError={() => {
              setImageError(true)
              setImageLoading(false)
            }}
          />
        </>
      ) : (
        <Text
          size="sm"
          weight="black"
          style={{
            color: tokens.colors.white,
            fontSize: size * 0.4,
            textShadow: 'var(--text-shadow-sm)',
          }}
        >
          {initial}
        </Text>
      )}
    </Box>
  )
}

/**
 * 简化版 Avatar（仅显示首字母，无图片）
 */
export function SimpleAvatar({
  userId,
  name,
  size = 40,
  className,
  style,
}: Omit<AvatarProps, 'avatarUrl'>) {
  const initial = getAvatarInitial(name || userId)
  const backgroundGradient = getAvatarGradient(userId)

  return (
    <Box
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: tokens.radius.full,
        overflow: 'hidden',
        flexShrink: 0,
        background: backgroundGradient,
        display: 'grid',
        placeItems: 'center',
        ...style,
      }}
    >
      <Text
        size="sm"
        weight="black"
        style={{
          color: tokens.colors.white,
          fontSize: size * 0.4,
          textShadow: 'var(--text-shadow-sm)',
        }}
      >
        {initial}
      </Text>
    </Box>
  )
}
