'use client'

import { ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
// @tanstack/react-query is a required peer dependency of wagmi (>=5.0.0)
// and @rainbow-me/rainbowkit. Do NOT remove this dependency.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { wagmiConfig } from './config'

import '@rainbow-me/rainbowkit/styles.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
})

export function Web3ProviderClient({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            accentColor: 'var(--color-verified-web3)',
            accentColorForeground: 'white',
            borderRadius: 'medium',
          })}
          locale="en"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}
