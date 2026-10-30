'use client'

/**
 * Privy state bridge.
 *
 * The Privy SDK is lazy-loaded (see PrivyClientProvider). To keep the app's
 * React tree shape stable, the PrivyProvider is mounted as a SIBLING host that
 * never wraps the app's children. A small bridge component rendered inside
 * that provider publishes the `usePrivy()` state into this store, and app
 * components read it via `usePrivyBridge()` instead of calling `usePrivy()`
 * directly (which would require being rendered inside the provider).
 */

import { create } from 'zustand'
import type { User } from '@privy-io/react-auth'

export interface PrivyBridgeState {
  /** True once the Privy SDK has loaded and finished initialising. */
  ready: boolean
  authenticated: boolean
  user: User | null
  /** Opens the Privy login modal; null until the SDK is loaded. */
  login: (() => void) | null
}

export const INITIAL_PRIVY_BRIDGE_STATE: PrivyBridgeState = {
  ready: false,
  authenticated: false,
  user: null,
  login: null,
}

export const usePrivyBridgeStore = create<PrivyBridgeState>(() => ({
  ...INITIAL_PRIVY_BRIDGE_STATE,
}))

export function usePrivyBridge(): PrivyBridgeState {
  const ready = usePrivyBridgeStore((s) => s.ready)
  const authenticated = usePrivyBridgeStore((s) => s.authenticated)
  const user = usePrivyBridgeStore((s) => s.user)
  const login = usePrivyBridgeStore((s) => s.login)
  return { ready, authenticated, user, login }
}

export function publishPrivyBridgeState(next: PrivyBridgeState): void {
  usePrivyBridgeStore.setState(next)
}

export function resetPrivyBridgeState(): void {
  usePrivyBridgeStore.setState({ ...INITIAL_PRIVY_BRIDGE_STATE })
}
