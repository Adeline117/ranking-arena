/**
 * 统一懒加载工具
 * 提供类型安全的动态导入和预加载支持
 */

import dynamic from 'next/dynamic'
import type { ComponentType, ReactNode } from 'react'

// ============================================
// 类型定义
// ============================================

interface LazyComponentOptions {
  /** 加载时显示的组件 */
  loading?: () => ReactNode
  /** 是否禁用 SSR */
  ssr?: boolean
  /** 预加载触发时机 */
  preload?: 'hover' | 'visible' | 'idle' | 'none'
}

type PreloadableComponent<P> = ComponentType<P> & {
  preload: () => Promise<void>
}

// ============================================
// 默认加载占位符
// ============================================

const DefaultLoadingPlaceholder = () => null

const SkeletonLoadingPlaceholder = () => (
  <div 
    className="animate-pulse bg-base-200 rounded-lg" 
    style={{ minHeight: '100px' }}
    aria-busy="true"
    aria-label="加载中"
  />
)

// ============================================
// 核心工具函数
// ============================================

/**
 * 创建懒加载组件
 * @param importFn 动态导入函数
 * @param options 配置选项
 */
export function lazyComponent<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>,
  options: LazyComponentOptions = {}
): PreloadableComponent<P> {
  const {
    loading = DefaultLoadingPlaceholder,
    ssr = true,
    preload: _preload = 'none',
  } = options

  // 缓存 Promise 用于预加载
  let modulePromise: Promise<{ default: ComponentType<P> }> | null = null

  const preloadFn = () => {
    if (!modulePromise) {
      modulePromise = importFn()
    }
    return modulePromise.then(() => {})
  }

  // 创建动态组件
  const DynamicComponent = dynamic(
    () => modulePromise || importFn(),
    {
      loading,
      ssr,
    }
  ) as PreloadableComponent<P>

  // 添加预加载方法
  DynamicComponent.preload = preloadFn

  return DynamicComponent
}

/**
 * 创建带骨架屏的懒加载组件
 */
export function lazyWithSkeleton<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>,
  options: Omit<LazyComponentOptions, 'loading'> = {}
): PreloadableComponent<P> {
  return lazyComponent(importFn, {
    ...options,
    loading: SkeletonLoadingPlaceholder,
  })
}

/**
 * 仅客户端渲染的懒加载组件
 */
export function lazyClientOnly<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>,
  options: Omit<LazyComponentOptions, 'ssr'> = {}
): PreloadableComponent<P> {
  return lazyComponent(importFn, {
    ...options,
    ssr: false,
  })
}

// ============================================
// 预加载工具
// ============================================

/**
 * 在空闲时间预加载组件
 */
export function preloadOnIdle(components: PreloadableComponent<any>[]): void {
  if (typeof window === 'undefined') return

  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => {
      components.forEach(component => component.preload())
    })
  } else {
    // 降级：使用 setTimeout
    setTimeout(() => {
      components.forEach(component => component.preload())
    }, 200)
  }
}

/**
 * 在交互时预加载组件（如 hover）
 */
export function createPreloadHandlers(components: PreloadableComponent<any>[]) {
  let preloaded = false
  
  const handlePreload = () => {
    if (preloaded) return
    preloaded = true
    components.forEach(component => component.preload())
  }

  return {
    onMouseEnter: handlePreload,
    onFocus: handlePreload,
    onTouchStart: handlePreload,
  }
}

/**
 * 基于 IntersectionObserver 的预加载
 */
export function useVisibilityPreload(
  components: PreloadableComponent<any>[],
  options: IntersectionObserverInit = {}
) {
  if (typeof window === 'undefined') return { ref: () => {} }

  let preloaded = false
  let observer: IntersectionObserver | null = null

  const ref = (element: HTMLElement | null) => {
    if (preloaded || !element) return

    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !preloaded) {
          preloaded = true
          components.forEach(component => component.preload())
          observer?.disconnect()
        }
      },
      { rootMargin: '200px', ...options }
    )

    observer.observe(element)
  }

  return { ref }
}

// ============================================
// 路由级别代码分割工具
// ============================================

/**
 * 为路由组件添加预加载支持
 */
export function withRoutePreload<P extends object>(
  importFn: () => Promise<{ default: ComponentType<P> }>
): PreloadableComponent<P> {
  return lazyComponent(importFn, {
    ssr: true,
    loading: SkeletonLoadingPlaceholder,
  })
}

// ============================================
// 导出
// ============================================

export type { LazyComponentOptions, PreloadableComponent }
