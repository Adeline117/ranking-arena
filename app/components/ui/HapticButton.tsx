'use client'

import { forwardRef, useCallback, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { useCapacitorHaptics, type HapticImpactStyle } from '@/lib/hooks/useCapacitor'

export interface HapticButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
  hapticStyle?: HapticImpactStyle
  hapticOnClick?: boolean
}

/**
 * Button component with haptic feedback for native apps.
 *
 * Usage:
 *   <HapticButton onClick={handleClick} hapticStyle="medium">
 *     Click me
 *   </HapticButton>
 */
const HapticButton = forwardRef<HTMLButtonElement, HapticButtonProps>(
  ({ children, hapticStyle = 'light', hapticOnClick = true, onClick, ...props }, ref) => {
    const { impact } = useCapacitorHaptics()

    const handleClick = useCallback(
      async (e: React.MouseEvent<HTMLButtonElement>) => {
        if (hapticOnClick) {
          await impact(hapticStyle)
        }
        onClick?.(e)
      },
      [hapticOnClick, hapticStyle, impact, onClick]
    )

    return (
      <button ref={ref} onClick={handleClick} {...props}>
        {children}
      </button>
    )
  }
)

HapticButton.displayName = 'HapticButton'

export default HapticButton

/**
 * HOC to add haptic feedback to any clickable component
 */
export function withHapticFeedback<P extends { onClick?: (...args: unknown[]) => void }>(
  WrappedComponent: React.ComponentType<P>,
  hapticStyle: HapticImpactStyle = 'light'
) {
  return function WithHapticFeedback(props: P) {
    const { impact } = useCapacitorHaptics()

    const handleClick = useCallback(
      async (...args: unknown[]) => {
        await impact(hapticStyle)
        props.onClick?.(...args)
      },
      [impact, props]
    )

    return <WrappedComponent {...props} onClick={handleClick} />
  }
}
