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
  isWalletAddress,
  generateBlockieSvg,
  type AvatarProps
} from '@/lib/utils/avatar'

// Domains in next.config remotePatterns — serve directly, skip /api/avatar proxy
const DIRECT_DOMAINS = new Set([
  'api.dicebear.com', 'robohash.org', 'i.pravatar.cc', 'randomuser.me',
  'gavatar.staticimgs.com', 'static.okx.com', 'etoro-cdn.etorostatic.com',
  'public.bscdnweb.com', 's1.bycsi.com', 'a.static-global.com',
  'static.phemex.com', 'www.arenafi.org', 'cdn.arenafi.org',
])

function needsProxy(url: string): boolean {
  if (!url || url.startsWith('data:') || url.startsWith('/')) return false
  try {
    const hostname = new URL(url).hostname
    if (DIRECT_DOMAINS.has(hostname)) return false
    if (hostname.endsWith('.supabase.co')) return false
    if (hostname.endsWith('.googleusercontent.com')) return false
  } catch { return true }
  return true
}

function resolveAvatarUrl(
  isTrader: boolean,
  avatarUrl: string | null | undefined,
  userId: string,
  name?: string | null
): string | null {
  if (isTrader) {
    const resolved = getTraderAvatarUrl(avatarUrl)
    if (resolved) return resolved
    // For on-chain traders (0x.../Solana addresses), generate blockie avatar
    if (isWalletAddress(userId)) return generateBlockieSvg(userId, 128)
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
  size = 40,
  className,
  style,
  isTrader = false,
}: AvatarProps): ReactElement {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  
  const initial = getAvatarInitial(name || userId)
  const backgroundGradient = getAvatarGradient(userId)
  
  const finalAvatarUrl = resolveAvatarUrl(isTrader, avatarUrl, userId, name)
  
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
            src={needsProxy(finalAvatarUrl) ? `/api/avatar?url=${encodeURIComponent(finalAvatarUrl)}` : finalAvatarUrl}
            alt={name || userId || 'Avatar'}
            width={size}
            height={size}
            sizes={`${size}px`}
            unoptimized
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

