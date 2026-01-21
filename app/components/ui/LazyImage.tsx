'use client'

import { useState, useRef, useEffect, CSSProperties } from 'react'
import Image, { ImageProps } from 'next/image'
import { tokens } from '@/lib/design-tokens'

interface LazyImageProps extends Omit<ImageProps, 'onLoad' | 'onError'> {
  /** 占位符背景色 */
  placeholderColor?: string
  /** 是否显示加载动画 */
  showSkeleton?: boolean
  /** 淡入动画持续时间（毫秒） */
  fadeInDuration?: number
  /** 加载失败时显示的内容 */
  fallback?: React.ReactNode
  /** 自定义容器样式 */
  containerStyle?: CSSProperties
}

/**
 * 懒加载图片组件
 * 支持骨架屏、淡入动画、错误处理
 */
export function LazyImage({
  src,
  alt,
  width,
  height,
  placeholderColor = tokens.colors.bg.tertiary,
  showSkeleton = true,
  fadeInDuration = 300,
  fallback,
  containerStyle,
  style,
  ...props
}: LazyImageProps) {
  const [isLoaded, setIsLoaded] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [isInView, setIsInView] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Intersection Observer 检测是否进入视口
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true)
            observer.unobserve(container)
          }
        })
      },
      {
        rootMargin: '100px', // 提前 100px 开始加载
        threshold: 0,
      }
    )

    observer.observe(container)

    return () => {
      observer.disconnect()
    }
  }, [])

  const handleLoad = () => {
    setIsLoaded(true)
  }

  const handleError = () => {
    setHasError(true)
  }

  // 计算容器尺寸
  const containerWidth = typeof width === 'number' ? width : '100%'
  const containerHeight = typeof height === 'number' ? height : 'auto'

  // 错误状态 - 显示 fallback 或默认占位符
  if (hasError) {
    return (
      <div
        ref={containerRef}
        style={{
          width: containerWidth,
          height: containerHeight,
          background: placeholderColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: tokens.radius.md,
          overflow: 'hidden',
          ...containerStyle,
        }}
      >
        {fallback || (
          <svg
            width={Math.min(Number(width) || 40, 40)}
            height={Math.min(Number(height) || 40, 40)}
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.text.tertiary}
            strokeWidth="1.5"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        )}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: containerWidth,
        height: containerHeight,
        overflow: 'hidden',
        borderRadius: tokens.radius.md,
        ...containerStyle,
      }}
    >
      {/* 骨架屏/占位符 */}
      {!isLoaded && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: placeholderColor,
            ...(showSkeleton && {
              backgroundImage: `linear-gradient(
                90deg,
                ${placeholderColor} 0%,
                rgba(255, 255, 255, 0.05) 50%,
                ${placeholderColor} 100%
              )`,
              backgroundSize: '200% 100%',
              animation: 'shimmer 1.5s infinite',
            }),
          }}
        />
      )}

      {/* 实际图片 - 只在进入视口后加载 */}
      {isInView && (
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          onLoad={handleLoad}
          onError={handleError}
          style={{
            ...style,
            opacity: isLoaded ? 1 : 0,
            transition: `opacity ${fadeInDuration}ms ease-in-out`,
          }}
          {...props}
        />
      )}
    </div>
  )
}

/**
 * 头像懒加载组件
 */
export function LazyAvatar({
  src,
  alt,
  size = 40,
  ...props
}: Omit<LazyImageProps, 'width' | 'height'> & { size?: number }) {
  return (
    <LazyImage
      src={src}
      alt={alt}
      width={size}
      height={size}
      containerStyle={{
        borderRadius: '50%',
        flexShrink: 0,
      }}
      {...props}
    />
  )
}

/**
 * 背景图片懒加载组件
 */
export function LazyBackgroundImage({
  src,
  children,
  style,
  ...props
}: Omit<LazyImageProps, 'width' | 'height' | 'alt'> & {
  children?: React.ReactNode
}) {
  const [isLoaded, setIsLoaded] = useState(false)
  const [isInView, setIsInView] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsInView(true)
            observer.unobserve(container)
          }
        })
      },
      { rootMargin: '100px' }
    )

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!isInView || !src) return

    const img = new window.Image()
    img.onload = () => setIsLoaded(true)
    img.src = typeof src === 'string' ? src : ''
  }, [isInView, src])

  return (
    <div
      ref={containerRef}
      style={{
        ...style,
        backgroundImage: isLoaded ? `url(${src})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        transition: 'opacity 0.3s ease-in-out',
      }}
      {...props}
    >
      {children}
    </div>
  )
}

export default LazyImage

