'use client'

/**
 * 优化图片组件
 * 封装 next/image 提供统一的图片优化策略
 */

import Image, { ImageProps } from 'next/image'
import { useState, useCallback, CSSProperties } from 'react'

// ============================================
// 类型定义
// ============================================

export interface OptimizedImageProps extends Omit<ImageProps, 'placeholder' | 'blurDataURL'> {
  /** 是否显示模糊占位符 */
  blur?: boolean
  /** 自定义模糊数据 URL（base64） */
  blurDataURL?: string
  /** 加载失败时的回退图片 */
  fallbackSrc?: string
  /** 是否显示加载状态 */
  showLoadingState?: boolean
  /** 图片加载完成回调 */
  onLoadComplete?: () => void
  /** 图片加载失败回调 */
  onError?: () => void
  /** 图片圆角 */
  rounded?: 'none' | 'sm' | 'md' | 'lg' | 'full'
  /** 图片适应方式 */
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down'
  /** 悬停效果 */
  hoverEffect?: 'none' | 'zoom' | 'brightness' | 'grayscale'
  /** 懒加载阈值（距离视口多少像素时开始加载） */
  lazyThreshold?: string
}

// ============================================
// 常量
// ============================================

// 默认的低质量模糊占位符（1x1 灰色像素）
const DEFAULT_BLUR_DATA_URL = 
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// 默认回退图片
const DEFAULT_FALLBACK_SRC = '/images/placeholder.png'

// 圆角映射
const ROUNDED_CLASSES: Record<string, string> = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '16px',
  full: '9999px',
}

// ============================================
// 组件
// ============================================

export default function OptimizedImage({
  src,
  alt,
  width,
  height,
  fill,
  blur = true,
  blurDataURL,
  fallbackSrc = DEFAULT_FALLBACK_SRC,
  showLoadingState = true,
  onLoadComplete,
  onError,
  rounded = 'md',
  objectFit = 'cover',
  hoverEffect = 'none',
  lazyThreshold = '200px',
  style,
  className = '',
  priority,
  ...props
}: OptimizedImageProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const [currentSrc, setCurrentSrc] = useState(src)

  // 处理加载完成
  const handleLoadComplete = useCallback(() => {
    setIsLoading(false)
    onLoadComplete?.()
  }, [onLoadComplete])

  // 处理加载错误
  const handleError = useCallback(() => {
    setHasError(true)
    setIsLoading(false)
    setCurrentSrc(fallbackSrc)
    onError?.()
  }, [fallbackSrc, onError])

  // 构建样式
  const containerStyle: CSSProperties = {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: ROUNDED_CLASSES[rounded],
    ...style,
  }

  // 悬停效果类名
  const hoverClasses: Record<string, string> = {
    none: '',
    zoom: 'hover:scale-105 transition-transform duration-300',
    brightness: 'hover:brightness-110 transition-all duration-300',
    grayscale: 'grayscale hover:grayscale-0 transition-all duration-300',
  }

  // 加载状态样式
  const loadingStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'var(--color-base-200, #2a2a2a)',
    transition: 'opacity 0.3s ease-in-out',
    opacity: isLoading && showLoadingState ? 1 : 0,
    pointerEvents: 'none',
  }

  // 确定占位符设置
  const placeholderProps = blur && !hasError && !priority
    ? {
        placeholder: 'blur' as const,
        blurDataURL: blurDataURL || DEFAULT_BLUR_DATA_URL,
      }
    : {}

  return (
    <div style={containerStyle} className={className}>
      <Image
        src={currentSrc}
        alt={alt}
        width={!fill ? width : undefined}
        height={!fill ? height : undefined}
        fill={fill}
        style={{
          objectFit,
          borderRadius: ROUNDED_CLASSES[rounded],
        }}
        className={hoverClasses[hoverEffect]}
        onLoad={handleLoadComplete}
        onError={handleError}
        loading={priority ? undefined : 'lazy'}
        priority={priority}
        sizes={fill ? '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw' : undefined}
        {...placeholderProps}
        {...props}
      />
      
      {/* 加载状态指示器 */}
      {showLoadingState && (
        <div style={loadingStyle} aria-hidden={!isLoading}>
          <LoadingSpinner />
        </div>
      )}
    </div>
  )
}

// ============================================
// 加载动画组件
// ============================================

function LoadingSpinner() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      style={{ animation: 'spin 1s linear infinite' }}
    >
      <style>
        {`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeDasharray="31.4"
        strokeDashoffset="10"
        strokeLinecap="round"
        style={{ opacity: 0.3 }}
      />
    </svg>
  )
}

// ============================================
// 预设变体
// ============================================

/**
 * 头像图片（简单版）
 * 注意：对于需要首字母回退、加载状态等功能的场景，请使用 UI/Avatar 组件
 */
export function AvatarImage({
  src,
  alt,
  size = 48,
  ...props
}: Omit<OptimizedImageProps, 'width' | 'height' | 'rounded'> & { size?: number }) {
  return (
    <OptimizedImage
      src={src || `https://api.dicebear.com/7.x/avataaars/svg?seed=${alt}`}
      alt={alt}
      width={size}
      height={size}
      rounded="full"
      objectFit="cover"
      {...props}
    />
  )
}

/** @deprecated 使用 AvatarImage 替代 */
export const Avatar = AvatarImage

/** 卡片封面图片 */
export function CardImage({
  aspectRatio = '16/9',
  ...props
}: OptimizedImageProps & { aspectRatio?: string }) {
  return (
    <div style={{ aspectRatio, position: 'relative', width: '100%' }}>
      <OptimizedImage
        fill
        objectFit="cover"
        rounded="lg"
        {...props}
      />
    </div>
  )
}

/** 缩略图 */
export function Thumbnail({
  src,
  alt,
  size = 64,
  ...props
}: Omit<OptimizedImageProps, 'width' | 'height'> & { size?: number }) {
  return (
    <OptimizedImage
      src={src}
      alt={alt}
      width={size}
      height={size}
      rounded="sm"
      objectFit="cover"
      showLoadingState={false}
      {...props}
    />
  )
}

/** 全宽 Hero 图片 */
export function HeroImage(props: Omit<OptimizedImageProps, 'fill' | 'priority'>) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '400px' }}>
      <OptimizedImage
        fill
        priority
        objectFit="cover"
        rounded="none"
        hoverEffect="none"
        {...props}
      />
    </div>
  )
}

// OptimizedImageProps 已在定义处导出
