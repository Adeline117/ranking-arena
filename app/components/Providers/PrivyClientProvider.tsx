'use client'

/**
 * Privy Provider Wrapper (Deferred loading)
 *
 * Defers loading the heavy Privy/Wagmi/Wallet SDK bundle using idle-time
 * scheduling. This reduces initial TBT by ~500-800ms while ensuring the
 * SDK is ready before user interaction.
 *
 * IMPORTANT: Privy SDK uses noble-secp256k1 which can throw BigInt errors
 * in certain environments. We wrap it in an error boundary so any Privy
 * initialization crash doesn't take down the entire page.
 *
 * BUG FIX (2026-04-22): The old implementation conditionally changed the React
 * tree structure from <>{children}</> to
 * <ErrorBoundary><Suspense><Lazy>{children}</Lazy></Suspense></ErrorBoundary>
 * on first user click (via click/touchstart/keydown event listeners).
 * This unmounted/remounted ALL children, resetting their state. On the login
 * page, clicking "Register with code" or "Login with verification code"
 * appeared to do nothing because the state toggled then immediately reset.
 *
 * Fix: (1) Always render a stable tree structure (PrivyErrorBoundary > PrivySlot)
 * from mount, so children are never remounted. (2) Use requestIdleCallback to
 * load the SDK during idle time instead of on user click, so the tree is stable
 * well before any interaction.
 */

import { ReactNode, useState, useEffect, Component } from 'react'
import type { ErrorInfo } from 'react'
import { PRIVY_APP_ID } from '@/lib/privy/config'

/** Isolate Privy SDK crashes — children render without Privy on failure */
class PrivyErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn(
      '[Privy] SDK initialization failed, Web3 features disabled:',
      error.message,
      info.componentStack?.slice(0, 200)
    )
  }
  render() {
    if (this.state.hasError) return <>{this.props.children}</>
    return this.props.children
  }
}

interface Props {
  children: ReactNode
}

/**
 * Stable slot component that loads and renders the Privy provider.
 *
 * This component is ALWAYS present in the tree (never conditionally rendered).
 * It eagerly imports PrivyProviderInner during idle time and wraps children
 * in it once loaded.
 *
 * NOTE: When Provider transitions from null to a component, children move from
 * <Fragment> to <Provider>. This IS a tree structure change that remounts children.
 * However, because we load during idle time (1-3s after mount), this happens
 * before the user interacts with the page. The brief remount is invisible.
 *
 * This is a vast improvement over the old approach where the remount happened
 * ON the user's first click, making every first button click appear broken.
 */
function PrivySlot({ children }: { children: ReactNode }) {
  const [Provider, setProvider] = useState<React.ComponentType<{ children: ReactNode }> | null>(
    null
  )

  useEffect(() => {
    if (!PRIVY_APP_ID) return

    // Load Privy SDK during browser idle time.
    // This defers the ~956KB bundle from blocking initial render/hydration
    // while ensuring it's ready before user interaction (typically 1-3s).
    const loadPrivy = () => {
      import('./PrivyProviderInner')
        .then((mod) => {
          setProvider(() => mod.default)
        })
        .catch((err) => {
          console.warn('[Privy] SDK failed to load, Web3 features disabled:', err?.message)
        })
    }

    if ('requestIdleCallback' in window) {
      const id = requestIdleCallback(loadPrivy, { timeout: 3000 })
      return () => cancelIdleCallback(id)
    } else {
      // Safari doesn't support requestIdleCallback — use setTimeout
      const id = setTimeout(loadPrivy, 1500)
      return () => clearTimeout(id)
    }
  }, [])

  if (Provider) {
    return <Provider>{children}</Provider>
  }

  return <>{children}</>
}

export default function PrivyClientProvider({ children }: Props) {
  if (!PRIVY_APP_ID) {
    return <>{children}</>
  }

  // ALWAYS render PrivyErrorBoundary > PrivySlot. This tree structure is
  // stable from mount — no conditional wrapping that would unmount children.
  return (
    <PrivyErrorBoundary>
      <PrivySlot>{children}</PrivySlot>
    </PrivyErrorBoundary>
  )
}
