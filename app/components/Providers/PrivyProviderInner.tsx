'use client'

import { useEffect } from 'react'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { PRIVY_APP_ID, privyConfig } from '@/lib/privy/config'
import { publishPrivyBridgeState, resetPrivyBridgeState } from '@/lib/privy/bridge-store'

/** Publishes usePrivy() state into the bridge store for app-wide consumers. */
function PrivyStateBridge() {
  const { ready, authenticated, user, login } = usePrivy()

  useEffect(() => {
    publishPrivyBridgeState({
      ready,
      authenticated,
      user: user ?? null,
      login: () => login(),
    })
  }, [ready, authenticated, user, login])

  useEffect(() => () => resetPrivyBridgeState(), [])

  return null
}

/**
 * Sibling host for the Privy SDK. It intentionally does NOT wrap the app's
 * children — see PrivyClientProvider for why.
 */
export default function PrivyProviderInner() {
  return (
    <PrivyProvider appId={PRIVY_APP_ID!} config={privyConfig}>
      <PrivyStateBridge />
    </PrivyProvider>
  )
}
