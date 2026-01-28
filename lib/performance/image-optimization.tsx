/**
 * 图片优化工具
 * 提供图片加载优化、WebP 转换、尺寸调整等功能
 */

import React from 'react'

/**
 * 图片优化选项
 */
export interface ImageOptimizationOptions {
  width?: number
  height?: number
  quality?: number
  format?: 'webp' | 'avif' | 'auto'
  priority?: boolean
}

/**
 * 获取优化后的图片 URL
 * 使用 Next.js Image Optimization API 或 CDN
 */
export function getOptimizedImageUrl(
  src: string,
  options: ImageOptimizationOptions = {}
): string {
  // 如果是外部 URL，使用 Next.js Image Optimization
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const params = new URLSearchParams()

    if (options.width) params.set('w', String(options.width))
    if (options.quality) params.set('q', String(options.quality))
    if (options.format && options.format !== 'auto') {
      params.set('f', options.format)
    }

    params.set('url', src)

    return `/_next/image?${params.toString()}`
  }

  // 本地图片直接返回
  return src
}

/**
 * 判断是否应该优先加载图片
 * 基于图片在视口中的位置
 */
export function shouldPrioritizeImage(index: number, isMobile: boolean = false): boolean {
  // 移动端：前 5 个图片优先加载
  // 桌面端：前 3 个图片优先加载
  const threshold = isMobile ? 5 : 3
  return index < threshold
}

/**
 * 获取头像图片的 srcset
 * 为不同设备提供不同尺寸
 */
export function getAvatarSrcSet(src: string): string {
  if (!src) return ''

  const sizes = [36, 48, 72, 96]
  return sizes
    .map(size => `${getOptimizedImageUrl(src, { width: size, quality: 85 })} ${size}w`)
    .join(', ')
}

/**
 * 图片加载策略
 */
export const IMAGE_LOADING_STRATEGY = {
  // 首屏关键图片 - eager + priority
  CRITICAL: {
    loading: 'eager' as const,
    priority: true,
  },
  // 近首屏图片 - lazy（但优先级高）
  ABOVE_FOLD: {
    loading: 'lazy' as const,
    priority: false,
  },
  // 折叠下方图片 - lazy + 低优先级
  BELOW_FOLD: {
    loading: 'lazy' as const,
    priority: false,
    decoding: 'async' as const,
  },
} as const

/**
 * 根据索引获取图片加载策略
 */
export function getImageLoadingStrategy(
  index: number,
  viewportPosition: 'above' | 'below' = 'above'
) {
  if (index < 3 && viewportPosition === 'above') {
    return IMAGE_LOADING_STRATEGY.CRITICAL
  }

  if (index < 10 && viewportPosition === 'above') {
    return IMAGE_LOADING_STRATEGY.ABOVE_FOLD
  }

  return IMAGE_LOADING_STRATEGY.BELOW_FOLD
}

/**
 * 预加载关键图片
 * 在 <head> 中插入 preload 链接
 */
export function preloadCriticalImages(images: string[]): React.ReactElement[] {
  return images.slice(0, 3).map((src, index) => (
    <link
      key={`preload-image-${index}`}
      rel="preload"
      as="image"
      href={getOptimizedImageUrl(src, { width: 72, quality: 85, format: 'webp' })}
      // @ts-ignore
      imageSrcSet={getAvatarSrcSet(src)}
      imageSizes="72px"
    />
  ))
}

/**
 * 检查浏览器是否支持 WebP
 * 服务端渲染时返回 true（Next.js 会自动处理）
 */
export function supportsWebP(): boolean {
  if (typeof window === 'undefined') return true

  const canvas = document.createElement('canvas')
  if (canvas.getContext && canvas.getContext('2d')) {
    return canvas.toDataURL('image/webp').indexOf('data:image/webp') === 0
  }
  return false
}

/**
 * 图片占位符 - Base64 编码的模糊图片
 * 用于防止布局偏移
 */
export const IMAGE_PLACEHOLDER = {
  avatar: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjMjEyMDI4Ii8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtc2l6ZT0iMjAiIGZpbGw9IiM5NTc1Q0QiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiPj88L3RleHQ+PC9zdmc+',
  logo: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiBmaWxsPSIjMjEyMDI4Ii8+PC9zdmc+',
}

/**
 * 图片加载错误处理
 */
export function handleImageError(
  event: React.SyntheticEvent<HTMLImageElement>,
  fallbackSrc?: string
) {
  const img = event.currentTarget

  if (fallbackSrc && img.src !== fallbackSrc) {
    img.src = fallbackSrc
  } else {
    // 如果没有 fallback 或 fallback 也失败了，隐藏图片
    img.style.display = 'none'
  }
}

/**
 * 延迟加载图片的 Intersection Observer 配置
 */
export const LAZY_LOAD_CONFIG = {
  rootMargin: '50px', // 提前 50px 开始加载
  threshold: 0.01, // 1% 可见即触发
}
