'use client'

import { useState, type ReactElement } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import {
  getAvatarGradient,
  getAvatarInitial,
  getUserAvatarUrl,
  getTraderAvatarUrl,
  type AvatarProps
} from '@/lib/utils/avatar'

function resolveAvatarUrl(
  isTrader: boolean,
  avatarUrl: string | null | undefined,
  userId: string,
  name?: string | null
): string | null {
  if (isTrader) return getTraderAvatarUrl(avatarUrl) ?? null
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
                  color: '#fff',
                  fontSize: size * 0.4,
                }}
              >
                {initial}
              </Text>
            </Box>
          )}
          <img
            src={finalAvatarUrl}
            alt={name || userId || 'Avatar'}
            loading="lazy"
            decoding="async"
            referrerPolicy="origin-when-cross-origin"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: imageLoading ? 'none' : 'block',
            }}
            onLoad={() => {
              setImageLoading(false)
            }}
            onError={(e) => {
              const img = e.target as HTMLImageElement
              const currentSrc = img?.src || finalAvatarUrl || ''
              
              // Bitget URL 可能需要添加扩展名
              const hasExtension = currentSrc && /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$|#)/i.test(currentSrc)
              const isBitgetUrl = currentSrc.includes('bgstatic.com')
              
              // 如果是 Bitget URL 且没有扩展名，尝试添加扩展名
              if (isBitgetUrl && !hasExtension && currentSrc && !currentSrc.includes('?')) {
                const urlWithJpg = `${currentSrc}.jpg`
                if (img && img.src === currentSrc) {
                  img.src = urlWithJpg
                  return
                }
              }
              
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
            color: '#fff',
            fontSize: size * 0.4,
            textShadow: '0 1px 2px rgba(0,0,0,0.2)',
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
          color: '#fff',
          fontSize: size * 0.4,
          textShadow: '0 1px 2px rgba(0,0,0,0.2)',
        }}
      >
        {initial}
      </Text>
    </Box>
  )
}

