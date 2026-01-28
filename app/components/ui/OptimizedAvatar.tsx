/**
 * 优化的头像组件
 * 使用 Next.js Image 和性能优化工具
 */

'use client'

import Image from 'next/image'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import {
  getOptimizedImageUrl,
  getImageLoadingStrategy,
  handleImageError,
  IMAGE_PLACEHOLDER,
} from '@/lib/performance/image-optimization'

export interface OptimizedAvatarProps {
  /** 用户 ID（用于生成渐变背景） */
  userId: string
  /** 显示名称（用于生成首字母） */
  name: string
  /** 头像 URL */
  avatarUrl?: string | null
  /** 头像尺寸（像素） */
  size?: number
  /** 是否优先加载（用于首屏关键图片） */
  priority?: boolean
  /** 在列表中的索引（用于自动判断是否优先加载） */
  index?: number
  /** 自定义边框 */
  border?: string
  /** 自定义阴影 */
  boxShadow?: string
  /** CSS 类名 */
  className?: string
}

/**
 * 优化的头像组件
 *
 * 特性：
 * - 使用 Next.js Image 自动优化
 * - WebP 格式支持
 * - 优先加载策略（前3个）
 * - Blur placeholder
 * - Retina 支持（2x）
 * - 错误处理和回退
 */
export function OptimizedAvatar({
  userId,
  name,
  avatarUrl,
  size = 40,
  priority: propPriority,
  index = 0,
  border = '2px solid var(--color-border-primary)',
  boxShadow,
  className = '',
}: OptimizedAvatarProps) {
  // 判断是否优先加载
  const shouldPrioritize = propPriority !== undefined ? propPriority : index < 3
  const loadingStrategy = getImageLoadingStrategy(index, 'above')

  return (
    <div
      className={`optimized-avatar ${className}`}
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius: '50%',
        background: getAvatarGradient(userId),
        border,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        flexShrink: 0,
        position: 'relative',
        boxShadow,
      }}
    >
      {/* 首字母回退 */}
      <span
        style={{
          color: '#ffffff',
          fontSize: Math.floor(size * 0.4),
          fontWeight: 900,
          lineHeight: 1,
          textShadow: '0 1px 3px rgba(0,0,0,0.8)',
        }}
      >
        {getAvatarInitial(name)}
      </span>

      {/* 头像图片（如果有） */}
      {avatarUrl && (
        <Image
          src={getOptimizedImageUrl(avatarUrl, {
            width: size * 2, // 2x for retina
            quality: 85,
            format: 'webp',
          })}
          alt={name}
          width={size}
          height={size}
          priority={shouldPrioritize}
          loading={loadingStrategy.loading}
          placeholder="blur"
          blurDataURL={IMAGE_PLACEHOLDER.avatar}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            position: 'absolute',
            inset: 0,
            zIndex: 1,
          }}
          onError={handleImageError}
        />
      )}
    </div>
  )
}

/**
 * 头像骨架屏
 * 用于加载状态
 */
export function AvatarSkeleton({ size = 40 }: { size?: number }) {
  return (
    <div
      className="avatar-skeleton"
      style={{
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius: '50%',
        background: 'linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.05) 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 2s infinite linear',
        flexShrink: 0,
      }}
    />
  )
}

export default OptimizedAvatar
