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
 * 显示用户头像，如果没有真实头像则显示基于用户ID生成的默认头像
 */
export default function Avatar({
  userId,
  name,
  avatarUrl,
  size = 40,
  className,
  style,
}: AvatarProps) {
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  
  // 获取最终头像URL
  const finalAvatarUrl = getUserAvatarUrl(userId, avatarUrl, name)
  const initial = getAvatarInitial(name || userId)
  const backgroundGradient = getAvatarGradient(userId)
  
  // 如果图片加载失败或没有URL，显示默认头像（使用渐变背景+首字母）
  const showDefault = imageError || !avatarUrl || !finalAvatarUrl

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
            alt={name || userId}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: imageLoading ? 'none' : 'block',
            }}
            onLoad={() => setImageLoading(false)}
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

