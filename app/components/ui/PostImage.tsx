'use client'

import { useState, type CSSProperties } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface PostImageProps {
  src: string
  alt?: string
  onClick?: () => void
  style?: CSSProperties
  className?: string
  maxHeight?: number
  showErrorMessage?: boolean
}

/**
 * PostImage 组件
 * 用于显示帖子中的图片，带有错误处理和加载状态
 */
export default function PostImage({
  src,
  alt = 'image',
  onClick,
  style,
  className,
  maxHeight = 300,
  showErrorMessage = true,
}: PostImageProps) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const handleError = () => {
    // 尝试重试一次（可能是临时网络问题）
    if (retryCount < 1) {
      setRetryCount(prev => prev + 1)
      // 添加时间戳参数强制刷新
      return
    }
    setError(true)
    setLoading(false)
  }

  const handleLoad = () => {
    setLoading(false)
    setError(false)
  }

  // 如果图片加载失败，显示错误占位符
  if (error) {
    return (
      <Box
        className={className}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.tertiary} 100%)`,
          borderRadius: tokens.radius.md,
          padding: tokens.spacing[4],
          minHeight: 120,
          maxHeight,
          border: `1px dashed ${tokens.colors.border.primary}`,
          ...style,
        }}
      >
        <Box
          style={{
            width: 48,
            height: 48,
            borderRadius: tokens.radius.full,
            background: `${tokens.colors.accent.error}15`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: tokens.spacing[2],
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.accent.error}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
            <line x1="4" y1="4" x2="20" y2="20" />
          </svg>
        </Box>
        {showErrorMessage && (
          <Text size="xs" color="tertiary" style={{ textAlign: 'center' }}>
            图片加载失败
          </Text>
        )}
      </Box>
    )
  }

  return (
    <Box
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        ...style,
      }}
    >
      {/* 加载状态骨架屏 */}
      {loading && (
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            background: `linear-gradient(90deg, ${tokens.colors.bg.secondary} 25%, ${tokens.colors.bg.tertiary} 50%, ${tokens.colors.bg.secondary} 75%)`,
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.5s infinite',
            borderRadius: tokens.radius.md,
          }}
        />
      )}
      <img
        src={retryCount > 0 ? `${src}${src.includes('?') ? '&' : '?'}retry=${retryCount}` : src}
        alt={alt}
        loading="lazy"
        decoding="async"
        style={{
          maxWidth: '100%',
          maxHeight,
          borderRadius: tokens.radius.md,
          cursor: onClick ? 'pointer' : 'default',
          display: loading ? 'none' : 'block',
          objectFit: 'contain',
        }}
        onClick={onClick}
        onLoad={handleLoad}
        onError={handleError}
      />
      <style jsx global>{`
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
      `}</style>
    </Box>
  )
}

/**
 * PostImageGallery 组件
 * 用于显示帖子中的多张图片
 */
interface PostImageGalleryProps {
  images: string[]
  onImageClick?: (url: string, index: number) => void
}

export function PostImageGallery({ images, onImageClick }: PostImageGalleryProps) {
  if (!images || images.length === 0) return null

  // 根据图片数量决定布局
  const getGridStyle = (count: number): CSSProperties => {
    if (count === 1) {
      return { display: 'block' }
    }
    if (count === 2) {
      return {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: tokens.spacing[2],
      }
    }
    if (count === 3) {
      return {
        display: 'grid',
        gridTemplateColumns: '2fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: tokens.spacing[2],
      }
    }
    // 4 or more
    return {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: tokens.spacing[2],
    }
  }

  return (
    <Box style={getGridStyle(images.length)}>
      {images.slice(0, 9).map((url, index) => (
        <PostImage
          key={`${url}-${index}`}
          src={url}
          alt={`Image ${index + 1}`}
          onClick={() => onImageClick?.(url, index)}
          maxHeight={images.length === 1 ? 400 : 200}
          style={
            images.length === 3 && index === 0
              ? { gridRow: 'span 2' }
              : undefined
          }
        />
      ))}
      {images.length > 9 && (
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tokens.colors.bg.tertiary,
            borderRadius: tokens.radius.md,
            padding: tokens.spacing[3],
          }}
        >
          <Text size="sm" color="secondary">
            +{images.length - 9} more
          </Text>
        </Box>
      )}
    </Box>
  )
}
