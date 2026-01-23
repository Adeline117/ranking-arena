/**
 * 图片预加载和懒加载 Hooks
 * 
 * 功能:
 * - 图片预加载
 * - 懒加载 (IntersectionObserver)
 * - 加载状态管理
 * - 错误处理
 */

'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ============================================
// useImagePreload - 图片预加载
// ============================================

export function useImagePreload(src: string | null | undefined) {
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!src) {
      setLoaded(false)
      setError(false)
      return
    }

    const img = new Image()
    
    img.onload = () => {
      setLoaded(true)
      setError(false)
    }
    
    img.onerror = () => {
      setLoaded(false)
      setError(true)
    }
    
    img.src = src

    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [src])

  return { loaded, error }
}

// ============================================
// useImageLazyLoad - 图片懒加载
// ============================================

export type LazyLoadState = 'idle' | 'loading' | 'loaded' | 'error'

export function useImageLazyLoad(
  src: string | null | undefined,
  options?: {
    rootMargin?: string
    threshold?: number
    placeholder?: string
  }
) {
  const { rootMargin = '100px', threshold = 0.1, placeholder } = options || {}
  
  const [state, setState] = useState<LazyLoadState>('idle')
  const [currentSrc, setCurrentSrc] = useState<string | undefined>(placeholder)
  const elementRef = useRef<HTMLImageElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  const loadImage = useCallback(() => {
    if (!src) return

    setState('loading')
    
    const img = new Image()
    
    img.onload = () => {
      setCurrentSrc(src)
      setState('loaded')
    }
    
    img.onerror = () => {
      setState('error')
    }
    
    img.src = src
  }, [src])

  useEffect(() => {
    if (!src) {
      setCurrentSrc(placeholder)
      setState('idle')
      return
    }

    // 创建 IntersectionObserver
    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          loadImage()
          observerRef.current?.disconnect()
        }
      },
      { rootMargin, threshold }
    )

    if (elementRef.current) {
      observerRef.current.observe(elementRef.current)
    }

    return () => {
      observerRef.current?.disconnect()
    }
  }, [src, loadImage, rootMargin, threshold, placeholder])

  return {
    ref: elementRef,
    src: currentSrc,
    state,
    isLoading: state === 'loading',
    isLoaded: state === 'loaded',
    isError: state === 'error',
  }
}

// ============================================
// usePrefetch - 资源预取
// ============================================

type PrefetchType = 'image' | 'script' | 'style' | 'fetch'

export function usePrefetch() {
  const prefetchedUrls = useRef<Set<string>>(new Set())

  const prefetch = useCallback((url: string, type: PrefetchType = 'fetch') => {
    if (prefetchedUrls.current.has(url)) return

    prefetchedUrls.current.add(url)

    if (type === 'image') {
      const img = new Image()
      img.src = url
    } else if (type === 'script' || type === 'style') {
      const link = document.createElement('link')
      link.rel = 'prefetch'
      link.href = url
      link.as = type
      document.head.appendChild(link)
    } else {
      // fetch prefetch
      fetch(url, { 
        method: 'GET',
        priority: 'low' as RequestPriority,
      }).catch(() => {})
    }
  }, [])

  const prefetchImages = useCallback((urls: string[]) => {
    urls.forEach(url => prefetch(url, 'image'))
  }, [prefetch])

  const prefetchPage = useCallback((url: string) => {
    // 预取页面的 HTML
    prefetch(url, 'fetch')
  }, [prefetch])

  return {
    prefetch,
    prefetchImages,
    prefetchPage,
  }
}

// ============================================
// useProgressiveImage - 渐进式图片加载
// ============================================

export function useProgressiveImage(
  lowResSrc: string | null | undefined,
  highResSrc: string | null | undefined
) {
  const [currentSrc, setCurrentSrc] = useState(lowResSrc)
  const [isHighResLoaded, setIsHighResLoaded] = useState(false)

  useEffect(() => {
    if (!highResSrc) return

    const img = new Image()
    
    img.onload = () => {
      setCurrentSrc(highResSrc)
      setIsHighResLoaded(true)
    }
    
    img.src = highResSrc

    return () => {
      img.onload = null
    }
  }, [highResSrc])

  // 重置低分辨率
  useEffect(() => {
    if (lowResSrc !== currentSrc && !isHighResLoaded) {
      setCurrentSrc(lowResSrc)
    }
  }, [lowResSrc, currentSrc, isHighResLoaded])

  return {
    src: currentSrc,
    isHighResLoaded,
    blur: !isHighResLoaded,
  }
}

// ============================================
// useCriticalCSS - 关键 CSS 注入
// ============================================

export function useCriticalCSS(css: string) {
  useEffect(() => {
    const styleId = 'critical-css-' + Math.random().toString(36).slice(2)
    
    // 检查是否已存在
    if (document.getElementById(styleId)) return

    const style = document.createElement('style')
    style.id = styleId
    style.textContent = css
    document.head.insertBefore(style, document.head.firstChild)

    return () => {
      const existingStyle = document.getElementById(styleId)
      if (existingStyle) {
        existingStyle.remove()
      }
    }
  }, [css])
}

// ============================================
// useIntersectionObserver - 通用可见性检测
// ============================================

export function useIntersectionObserver(
  options?: {
    root?: Element | null
    rootMargin?: string
    threshold?: number | number[]
    triggerOnce?: boolean
  }
) {
  const { rootMargin = '0px', threshold = 0, triggerOnce = false } = options || {}
  
  const [isIntersecting, setIsIntersecting] = useState(false)
  const [hasIntersected, setHasIntersected] = useState(false)
  const elementRef = useRef<HTMLElement | null>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      ([entry]) => {
        const isVisible = entry.isIntersecting
        setIsIntersecting(isVisible)
        
        if (isVisible) {
          setHasIntersected(true)
          if (triggerOnce) {
            observerRef.current?.disconnect()
          }
        }
      },
      { rootMargin, threshold }
    )

    if (elementRef.current) {
      observerRef.current.observe(elementRef.current)
    }

    return () => {
      observerRef.current?.disconnect()
    }
  }, [rootMargin, threshold, triggerOnce])

  return {
    ref: elementRef,
    isIntersecting,
    hasIntersected,
  }
}

const imagePreloadHooks = {
  useImagePreload,
  useImageLazyLoad,
  usePrefetch,
  useProgressiveImage,
  useCriticalCSS,
  useIntersectionObserver,
}
export default imagePreloadHooks
