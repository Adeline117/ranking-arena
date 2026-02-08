'use client'

/**
 * HOC that wraps a component with Web3Provider.
 * Use this for components that need wagmi/RainbowKit hooks
 * but are loaded outside the root Web3Provider.
 */

import { ComponentType, ReactNode } from 'react'
import { Web3Provider } from './provider'

export function withWeb3<P extends object>(
  Component: ComponentType<P>
): ComponentType<P> {
  function WrappedWithWeb3(props: P) {
    return (
      <Web3Provider>
        <Component {...props} />
      </Web3Provider>
    )
  }
  WrappedWithWeb3.displayName = `withWeb3(${Component.displayName || Component.name || 'Component'})`
  return WrappedWithWeb3
}

/**
 * Boundary component version — wrap JSX directly:
 *   <Web3Boundary><WalletSection /></Web3Boundary>
 */
export function Web3Boundary({ children }: { children: ReactNode }) {
  return <Web3Provider>{children}</Web3Provider>
}
