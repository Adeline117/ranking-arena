'use client'

/**
 * 功能开关 React Hooks
 */

import { useState, useEffect, useContext, createContext, useMemo, useCallback, useRef } from 'react'
import {
  isFeatureEnabledWithOverrides,
  getAllFeatureFlags,
  setFeatureFlagOverride,
  clearFeatureFlagOverride,
  type FeatureFlagName,
} from './index'

// ============================================
// Context
// ============================================

interface FeatureFlagContextValue {
  flags: Record<FeatureFlagName, boolean>
  isEnabled: (flag: FeatureFlagName) => boolean
  setOverride: (flag: FeatureFlagName, enabled: boolean) => void
  clearOverride: (flag: FeatureFlagName) => void
  userId?: string
}

const FeatureFlagContext = createContext<FeatureFlagContextValue | null>(null)

// ============================================
// Provider
// ============================================

interface FeatureFlagProviderProps {
  children: React.ReactNode
  userId?: string
  initialFlags?: Partial<Record<FeatureFlagName, boolean>>
}

/**
 * 功能开关 Provider
 * 
 * @example
 * ```tsx
 * <FeatureFlagProvider userId={user?.id}>
 *   <App />
 * </FeatureFlagProvider>
 * ```
 */
export function FeatureFlagProvider({
  children,
  userId,
  initialFlags,
}: FeatureFlagProviderProps) {
  // 使用 ref 来稳定 initialFlags，避免不必要的重新计算
  const initialFlagsRef = useRef(initialFlags)
  useEffect(() => {
    initialFlagsRef.current = initialFlags
  }, [initialFlags])

  const [flags, setFlags] = useState<Record<FeatureFlagName, boolean>>(() => ({
    ...getAllFeatureFlags({ userId }),
    ...(initialFlags || {}),
  }))

  // 当 userId 变化时重新计算 flags
  useEffect(() => {
    setFlags({
      ...getAllFeatureFlags({ userId }),
      ...(initialFlagsRef.current || {}),
    })
  }, [userId])

  const isEnabled = useCallback((flag: FeatureFlagName) => {
    return flags[flag] ?? isFeatureEnabledWithOverrides(flag, { userId })
  }, [flags, userId])

  const setOverride = useCallback((flag: FeatureFlagName, enabled: boolean) => {
    setFeatureFlagOverride(flag, enabled)
    setFlags(prev => ({ ...prev, [flag]: enabled }))
  }, [])

  const clearOverride = useCallback((flag: FeatureFlagName) => {
    clearFeatureFlagOverride(flag)
    setFlags(prev => ({
      ...prev,
      [flag]: isFeatureEnabledWithOverrides(flag, { userId }),
    }))
  }, [userId])

  const value = useMemo(
    () => ({
      flags,
      isEnabled,
      setOverride,
      clearOverride,
      userId,
    }),
    [flags, isEnabled, setOverride, clearOverride, userId]
  )

  return (
    <FeatureFlagContext.Provider value={value}>
      {children}
    </FeatureFlagContext.Provider>
  )
}

// ============================================
// Hooks
// ============================================

/**
 * 获取功能开关上下文
 */
export function useFeatureFlags() {
  const context = useContext(FeatureFlagContext)
  if (!context) {
    throw new Error('useFeatureFlags must be used within a FeatureFlagProvider')
  }
  return context
}

/**
 * 检查单个功能开关是否启用
 * 
 * @example
 * ```tsx
 * function MyComponent() {
 *   const isNewUIEnabled = useFeatureFlag('new_trader_ui')
 *   
 *   if (isNewUIEnabled) {
 *     return <NewTraderUI />
 *   }
 *   return <OldTraderUI />
 * }
 * ```
 */
export function useFeatureFlag(flag: FeatureFlagName): boolean {
  const context = useContext(FeatureFlagContext)
  
  // Always call hooks unconditionally
  const [fallbackEnabled, setFallbackEnabled] = useState(() => 
    isFeatureEnabledWithOverrides(flag)
  )
  
  useEffect(() => {
    if (!context) {
      setFallbackEnabled(isFeatureEnabledWithOverrides(flag))
    }
  }, [flag, context])
  
  // Use context if available, otherwise use fallback
  if (context) {
    return context.isEnabled(flag)
  }
  
  return fallbackEnabled
}

/**
 * 条件渲染组件
 * 
 * @example
 * ```tsx
 * <FeatureFlag flag="new_trader_ui">
 *   <NewTraderUI />
 * </FeatureFlag>
 * 
 * // 或者带 fallback
 * <FeatureFlag flag="new_trader_ui" fallback={<OldTraderUI />}>
 *   <NewTraderUI />
 * </FeatureFlag>
 * ```
 */
export function FeatureFlag({
  flag,
  children,
  fallback = null,
}: {
  flag: FeatureFlagName
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  const isEnabled = useFeatureFlag(flag)
  return isEnabled ? <>{children}</> : <>{fallback}</>
}

/**
 * A/B 测试组件
 * 
 * @example
 * ```tsx
 * <ABTest flag="new_trader_ui">
 *   <ABTest.Variant name="control">
 *     <OldTraderUI />
 *   </ABTest.Variant>
 *   <ABTest.Variant name="treatment">
 *     <NewTraderUI />
 *   </ABTest.Variant>
 * </ABTest>
 * ```
 */
export function ABTest({
  flag,
  children,
}: {
  flag: FeatureFlagName
  children: React.ReactNode
}) {
  const isEnabled = useFeatureFlag(flag)
  
  // 找到正确的变体
  type VariantElement = React.ReactElement<{ name: 'control' | 'treatment'; children: React.ReactNode }>
  
  const variants = (Array.isArray(children) ? children : [children]).filter(
    (child): child is VariantElement => 
      child != null && 
      typeof child === 'object' && 
      'props' in child &&
      (child as VariantElement).props?.name != null
  )
  
  const controlVariant = variants.find(v => v.props.name === 'control')
  const treatmentVariant = variants.find(v => v.props.name === 'treatment')
  
  if (isEnabled && treatmentVariant) {
    return <>{treatmentVariant.props.children}</>
  }
  
  if (controlVariant) {
    return <>{controlVariant.props.children}</>
  }
  
  return null
}

// A/B Test Variant 子组件
ABTest.Variant = function Variant({
  name: _name,
  children,
}: {
  name: 'control' | 'treatment'
  children: React.ReactNode
}) {
  return <>{children}</>
}
