'use client'

import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

interface PageTransitionProps {
  children: ReactNode
  className?: string
  animation?: 'fade' | 'slide' | 'scale' | 'slideLeft'
}

/**
 * 页面过渡动画包装组件
 * 在路由切换时自动添加进入动画
 */
export function PageTransition({ 
  children, 
  className = '',
  animation = 'fade' 
}: PageTransitionProps) {
  const pathname = usePathname()
  const [isVisible, setIsVisible] = useState(false)
  const [key, setKey] = useState(pathname)

  useEffect(() => {
    setIsVisible(false)
    // 短暂延迟后显示内容，触发动画
    const timer = setTimeout(() => {
      setKey(pathname)
      setIsVisible(true)
    }, 10)

    return () => clearTimeout(timer)
  }, [pathname])

  const animationClass = {
    fade: 'page-enter',
    slide: 'page-slide-in',
    scale: 'page-enter-scale',
    slideLeft: 'page-slide-in-left',
  }[animation]

  return (
    <div 
      key={key}
      className={`${isVisible ? animationClass : ''} ${className}`}
      style={{
        opacity: isVisible ? undefined : 0,
      }}
    >
      {children}
    </div>
  )
}

/**
 * 列表项交错动画包装组件
 */
export function StaggerList({ 
  children, 
  className = '',
  fast = false,
}: { 
  children: ReactNode
  className?: string
  fast?: boolean 
}) {
  return (
    <div className={`${fast ? 'stagger-fast' : 'stagger-children'} ${className}`}>
      {children}
    </div>
  )
}

/**
 * 卡片入场动画包装组件
 */
export function CardEnter({ 
  children, 
  className = '',
  delay = 0,
}: { 
  children: ReactNode
  className?: string
  delay?: number 
}) {
  return (
    <div 
      className={`card-enter ${className}`}
      style={{ animationDelay: delay ? `${delay}ms` : undefined }}
    >
      {children}
    </div>
  )
}

export default PageTransition

