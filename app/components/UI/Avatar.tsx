'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../Base'
import { 
  getAvatarGradient, 
  getAvatarInitial,
  getUserAvatarUrl,
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
}: AvatarProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  
  const initial = getAvatarInitial(name || userId)
  const backgroundGradient = getAvatarGradient(userId)
  
  // 对于 trader：如果有 avatarUrl 则使用，否则显示首字母头像（不生成）
  // 对于普通用户：
  // - avatarUrl 有值且不为空：使用设置的头像
  // - avatarUrl 为 null：在排行榜上但没有设置头像，显示首字母（不生成）
  // - avatarUrl 为 undefined：不在排行榜上，生成默认头像
  let finalAvatarUrl: string | null | undefined = null
  
  // 调试日志：记录前几个trader的头像URL
  if (isTrader && (name?.includes('老') || name?.includes('East') || name?.includes('Rock') || name?.includes('Encryption'))) {
    console.log(`[Avatar] Trader "${name}" (${userId}):`, {
      avatarUrl,
      avatarUrl_type: typeof avatarUrl,
      avatarUrl_value: avatarUrl,
      isTrader,
    })
  }
  
  if (isTrader) {
    // trader：如果有 avatarUrl 且不为空，则使用；否则显示首字母头像（不生成）
    if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.trim() !== '') {
      finalAvatarUrl = avatarUrl.trim()
    } else {
      finalAvatarUrl = null // 没有头像URL，显示首字母头像
      
      // 调试日志：如果没有头像URL，输出警告
      if (name && (name.includes('老') || name.includes('East') || name.includes('Rock') || name.includes('Encryption'))) {
        console.warn(`[Avatar] ⚠️ Trader "${name}" 没有头像URL:`, {
          avatarUrl,
          avatarUrl_type: typeof avatarUrl,
          avatarUrl_length: avatarUrl?.length || 0,
        })
      }
    }
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
      className={className}
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
            crossOrigin="anonymous"
            referrerPolicy="no-referrer"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: imageLoading ? 'none' : 'block',
            }}
            onLoad={() => {
              console.log(`[Avatar] ✅ 图片加载成功: "${finalAvatarUrl}"`, {
                name,
                userId,
                isTrader,
              })
              setImageLoading(false)
            }}
            onError={(e) => {
              console.error(`[Avatar] ❌ 图片加载失败: "${finalAvatarUrl}"`, {
                name,
                userId,
                isTrader,
                error: e,
                url_type: typeof finalAvatarUrl,
                url_length: finalAvatarUrl?.length || 0,
                url_preview: finalAvatarUrl ? finalAvatarUrl.substring(0, 80) : '(空)',
                // 尝试添加扩展名后的URL（用于调试）
                url_with_jpg: finalAvatarUrl && !finalAvatarUrl.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?|$|#)/i) 
                  ? `${finalAvatarUrl}.jpg` 
                  : null,
                url_with_png: finalAvatarUrl && !finalAvatarUrl.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?|$|#)/i) 
                  ? `${finalAvatarUrl}.png` 
                  : null,
              })
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

