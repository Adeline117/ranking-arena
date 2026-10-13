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
 * Fix (2026-04-22): load the SDK during idle time instead of on first click.
 *
 * BUG FIX (2026-10-13): even the idle-time version swapped
 * <>{children}</> for <Provider>{children}</Provider> once the SDK loaded,
 * which still remounted the ENTIRE app subtree 1-3s after load (login inputs
 * cleared, selected period reset, sidebars flashed). Now the Privy provider is
 * mounted as a SIBLING host that never wraps children, so the children's
 * position in the tree never changes. Privy state is published to app
 * components through `usePrivyBridge()` (lib/privy/bridge-store.ts).
 */

import { ReactNode, useState, useEffect, Component } from 'react'
import type { ErrorInfo } from 'react'
import { PRIVY_APP_ID } from '@/lib/privy/config'

/** Isolate Privy SDK crashes — the app keeps rendering without Privy on failure */
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
    if (this.state.hasError) return null
    return this.props.children
  }
}

interface Props {
  children: ReactNode
}

/**
 * Lazy sibling host: loads PrivyProviderInner during idle time and renders it
 * NEXT TO (not around) the app. Its render output changing never affects the
 * app subtree.
 */
function PrivyHost() {
  const [Host, setHost] = useState<React.ComponentType | null>(null)

  useEffect(() => {
    if (!PRIVY_APP_ID) return

    // Load Privy SDK during browser idle time.
    // This defers the ~956KB bundle from blocking initial render/hydration.
    const loadPrivy = () => {
      import('./PrivyProviderInner')
        .then((mod) => {
          setHost(() => mod.default)
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

  return Host ? <Host /> : null
}

export default function PrivyClientProvider({ children }: Props) {
  // Tree shape is identical with or without Privy configured / loaded:
  // children always sit at the same position, the host is a sibling.
  return (
    <>
      {children}
      {PRIVY_APP_ID ? (
        <PrivyErrorBoundary>
          <PrivyHost />
        </PrivyErrorBoundary>
      ) : null}
    </>
  )
}
