'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'

// 进度条颜色
const PROGRESS_COLOR = tokens.colors.accent.primary || '#8b6fa8'

/**
 * 全局页面加载进度条
 * NProgress 风格的顶部进度条，在页面切换时自动显示
 */
export function GlobalProgress() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [progress, setProgress] = useState(0)
  const [isVisible, setIsVisible] = useState(false)
  const [isComplete, setIsComplete] = useState(false)
  const animationRef = useRef<number | null>(null)
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 开始进度
  const start = useCallback(() => {
    setIsVisible(true)
    setIsComplete(false)
    setProgress(0)

    // 使用动画帧逐步增加进度
    let currentProgress = 0
    const animate = () => {
      // 缓慢增加进度，最高到 90%
      if (currentProgress < 90) {
        // 越接近 90% 速度越慢
        const increment = (90 - currentProgress) * 0.03
        currentProgress = Math.min(currentProgress + increment, 90)
        setProgress(currentProgress)
        animationRef.current = requestAnimationFrame(animate)
      }
    }
    animationRef.current = requestAnimationFrame(animate)
  }, [])

  // 完成进度
  const complete = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }

    setProgress(100)
    setIsComplete(true)

    // 完成后延迟隐藏
    timeoutRef.current = setTimeout(() => {
      setIsVisible(false)
      setProgress(0)
    }, 300)
  }, [])

  // 监听路由变化
  useEffect(() => {
    // 路由变化时触发完成
    complete()
  }, [pathname, searchParams, complete])

  // 监听页面切换开始
  useEffect(() => {
    const _handleStart = () => {
      start()
    }

    // 监听链接点击
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const anchor = target.closest('a')
      
      if (anchor && anchor.href && !anchor.target && !anchor.download) {
        const url = new URL(anchor.href, window.location.origin)
        
        // 只在内部链接时显示进度条
        if (url.origin === window.location.origin && url.pathname !== pathname) {
          start()
        }
      }
    }

    document.addEventListener('click', handleClick, true)

    return () => {
      document.removeEventListener('click', handleClick, true)
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [pathname, start])

  if (!isVisible) return null

  return (
    <>
      {/* 进度条 */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          zIndex: tokens.zIndex.toast,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            background: `linear-gradient(90deg, ${PROGRESS_COLOR}, ${PROGRESS_COLOR}dd)`,
            boxShadow: `0 0 10px ${PROGRESS_COLOR}, 0 0 5px ${PROGRESS_COLOR}`,
            transition: isComplete 
              ? 'width 0.2s ease-out, opacity 0.3s ease-out' 
              : 'width 0.1s ease-out',
            opacity: isComplete ? 0 : 1,
            borderRadius: '0 2px 2px 0',
          }}
        />
      </div>

      {/* 顶部光晕效果 */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: 100,
          height: 3,
          zIndex: tokens.zIndex.toast,
          pointerEvents: 'none',
          background: `linear-gradient(90deg, transparent, ${PROGRESS_COLOR})`,
          opacity: isComplete ? 0 : (progress > 10 ? 0.8 : 0),
          transition: 'opacity 0.3s ease',
          transform: `translateX(${progress - 100}%)`,
        }}
      />
    </>
  )
}

/**
 * 手动控制进度条的 Hook
 */
export function useProgress() {
  const [progress, setProgress] = useState(0)
  const [isLoading, setIsLoading] = useState(false)

  const start = useCallback(() => {
    setIsLoading(true)
    setProgress(0)
  }, [])

  const set = useCallback((value: number) => {
    setProgress(Math.min(Math.max(value, 0), 100))
  }, [])

  const complete = useCallback(() => {
    setProgress(100)
    setTimeout(() => {
      setIsLoading(false)
      setProgress(0)
    }, 300)
  }, [])

  return { progress, isLoading, start, set, complete }
}

export default GlobalProgress

