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

/**
 * Avatar 组件
 * 显示用户头像
 * - 如果是 trader：有 avatarUrl 则使用，没有则显示首字母头像（不生成）
 * - 如果是普通用户：
 *   - 如果设置了头像（avatarUrl），使用设置的头像
 *   - 如果没有设置头像：
 *     - 如果 avatarUrl 是 null（在排行榜上），显示首字母头像（不生成）
 *     - 如果 avatarUrl 是 undefined（不在排行榜上），生成默认头像
 */
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
  
  // 对于 trader：如果有 avatarUrl 则使用代理，否则显示首字母头像（不生成）
  // 对于普通用户：
  // - avatarUrl 有值且不为空：使用设置的头像
  // - avatarUrl 为 null：在排行榜上但没有设置头像，显示首字母（不生成）
  // - avatarUrl 为 undefined：不在排行榜上，生成默认头像
  let finalAvatarUrl: string | null | undefined = null

  if (isTrader) {
    // trader：使用代理URL来解决CORS问题
    finalAvatarUrl = getTraderAvatarUrl(avatarUrl)
  } else {
    // 普通用户
    if (avatarUrl && avatarUrl.trim() !== '') {
      // 设置了头像，使用设置的头像
      finalAvatarUrl = avatarUrl
    } else if (avatarUrl === null) {
      // avatarUrl 为 null 表示在排行榜上但没有设置头像，不生成头像
      finalAvatarUrl = null
    } else {
      // avatarUrl 为 undefined 表示不在排行榜上，生成默认头像
      finalAvatarUrl = getUserAvatarUrl(userId, null, name)
    }
  }
  
  // 如果图片加载失败或没有URL，显示默认头像
  const showDefault = imageError || !finalAvatarUrl || finalAvatarUrl === null

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

