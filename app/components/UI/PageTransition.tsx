'use client'

import { ReactNode, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

interface PageTransitionProps {
  children: ReactNode
  className?: string
  animation?: 'fade' | 'slide' | 'scale'
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
    scale: 'page-scale-in',
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
  className = '' 
}: { 
  children: ReactNode
  className?: string 
}) {
  return (
    <div className={`stagger-enter ${className}`}>
      {children}
    </div>
  )
}

export default PageTransition

