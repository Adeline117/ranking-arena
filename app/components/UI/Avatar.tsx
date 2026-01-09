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
            referrerPolicy="no-referrer"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: imageLoading ? 'none' : 'block',
            }}
            onLoad={() => {
              console.log(`[Avatar] ✅ 图片加载成功: "${finalAvatarUrl?.substring(0, 80)}${finalAvatarUrl && finalAvatarUrl.length > 80 ? '...' : ''}"`, {
                name,
                userId,
                isTrader,
              })
              setImageLoading(false)
            }}
            onError={(e) => {
              const img = e.target as HTMLImageElement
              const currentSrc = img?.src || finalAvatarUrl || ''
              
              // Bitget的URL格式可能是：https://qrc.bgstatic.com/otc/images/20251219/1766158080640
              // 这个URL可能没有扩展名，但Bitget CDN可能支持直接访问（通过Content-Type判断）
              // 如果加载失败，尝试添加常见扩展名
              const hasExtension = currentSrc && /\.(jpg|jpeg|png|gif|webp|svg|ico)(\?|$|#)/i.test(currentSrc)
              
              console.error(`[Avatar] ❌ 图片加载失败: "${currentSrc.substring(0, 100)}${currentSrc.length > 100 ? '...' : ''}"`, {
                name,
                userId,
                isTrader,
                url_type: typeof finalAvatarUrl,
                url_length: currentSrc?.length || 0,
                url_has_extension: hasExtension,
                error_target: img?.src || '(空)',
              })
              
              // 如果URL没有扩展名且还没尝试过添加扩展名，尝试添加.jpg
              if (!hasExtension && currentSrc && !currentSrc.endsWith('.jpg') && !currentSrc.endsWith('.png')) {
                // 尝试添加 .jpg 扩展名
                const urlWithJpg = `${currentSrc}.jpg`
                console.log(`[Avatar] 🔄 尝试使用 .jpg 扩展名: "${urlWithJpg.substring(0, 100)}${urlWithJpg.length > 100 ? '...' : ''}"`)
                
                // 创建一个新的Image对象测试这个URL是否有效
                const testImg = new Image()
                testImg.onload = () => {
                  console.log(`[Avatar] ✅ .jpg 扩展名有效，更新src`)
                  if (img) {
                    img.src = urlWithJpg
                  }
                  setImageLoading(false)
                  // 不设置error，让新URL尝试加载
                }
                testImg.onerror = () => {
                  // .jpg 也失败，尝试 .png
                  const urlWithPng = `${currentSrc}.png`
                  console.log(`[Avatar] 🔄 .jpg 失败，尝试 .png: "${urlWithPng.substring(0, 100)}${urlWithPng.length > 100 ? '...' : ''}"`)
                  
                  const testImg2 = new Image()
                  testImg2.onload = () => {
                    console.log(`[Avatar] ✅ .png 扩展名有效，更新src`)
                    if (img) {
                      img.src = urlWithPng
                    }
                    setImageLoading(false)
                  }
                  testImg2.onerror = () => {
                    console.error(`[Avatar] ❌ .jpg 和 .png 都失败，使用fallback头像`)
                    setImageError(true)
                    setImageLoading(false)
                  }
                  testImg2.src = urlWithPng
                }
                testImg.src = urlWithJpg
                return // 不设置error，等待测试结果
              }
              
              // 如果已经尝试过扩展名或URL本身有问题，使用fallback
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

