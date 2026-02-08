'use client'

/**
 * Web3Provider — Lazy-loaded wallet SDK boundary
 *
 * NOT loaded at app root. Instead, wrap individual wallet-using sections:
 *   <Web3Provider><WalletSection /></Web3Provider>
 *
 * The ~3.7MB wallet SDK (wagmi, RainbowKit, WalletConnect, MetaMask, Coinbase)
 * is only loaded when this component mounts — i.e., when the user navigates
 * to a page that actually needs wallet features.
 */

import { ReactNode, useState, useEffect, createContext, useContext } from 'react'

// Context to detect whether we're inside a Web3Provider
const Web3ReadyContext = createContext(false)
export const useWeb3Ready = () => useContext(Web3ReadyContext)

interface Web3ProviderProps {
  children: ReactNode
}

export function Web3Provider({ children }: Web3ProviderProps) {
  const [Provider, setProvider] = useState<React.ComponentType<{ children: ReactNode }> | null>(null)

  useEffect(() => {
    // Dynamic import — only loads the ~3.7MB wallet SDK bundle on mount
    import('./Web3ProviderClient').then(mod => {
      setProvider(() => mod.Web3ProviderClient)
    })
  }, [])

  if (!Provider) {
    // Render children without web3 context while loading
    return <Web3ReadyContext.Provider value={false}>{children}</Web3ReadyContext.Provider>
  }

  return (
    <Web3ReadyContext.Provider value={true}>
      <Provider>{children}</Provider>
    </Web3ReadyContext.Provider>
  )
}
