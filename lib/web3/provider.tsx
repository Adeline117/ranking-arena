'use client'

/**
 * Web3Provider
 *
 * Wraps the app with wagmi + RainbowKit + TanStack Query providers.
 * Uses dynamic import with ssr:false to prevent @walletconnect/core
 * from calling localStorage during SSR.
 */

import { ReactNode, useState, useEffect } from 'react'

interface Web3ProviderProps {
  children: ReactNode
}

// Lazy-load the actual provider to avoid SSR localStorage crash
function Web3ProviderInner({ children }: Web3ProviderProps) {
  const [mounted, setMounted] = useState(false)
  const [Provider, setProvider] = useState<React.ComponentType<{ children: ReactNode }> | null>(null)

  useEffect(() => {
    setMounted(true)
    // Dynamic import only on client
    import('./Web3ProviderClient').then(mod => {
      setProvider(() => mod.Web3ProviderClient)
    })
  }, [])

  if (!mounted || !Provider) {
    // Render children without web3 context during SSR / loading
    return <>{children}</>
  }

  return <Provider>{children}</Provider>
}

export function Web3Provider({ children }: Web3ProviderProps) {
  return <Web3ProviderInner>{children}</Web3ProviderInner>
}
