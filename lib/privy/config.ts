/**
 * Privy Configuration
 *
 * ⚠️ Requires NEXT_PUBLIC_PRIVY_APP_ID in .env.local
 * Get it from https://dashboard.privy.io
 * Install: npm install @privy-io/react-auth
 */

import { BASE_URL } from '@/lib/constants/urls'

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || ''

// A public app id is not an identity bridge. Keep the login entry point closed
// until the backend verifies Privy tokens and issues a matching Supabase
// session. This is deliberately not an environment switch: enabling it must
// arrive together with the verified server implementation.
export const PRIVY_SUPABASE_BRIDGE_READY = false

export const privyConfig: Record<string, unknown> = {
  loginMethods: ['google', 'email', 'wallet'],
  appearance: {
    theme: 'dark',
    accentColor: '#7C3AED',
    logo: `${BASE_URL}/logo-symbol.png`,
  },
  embeddedWallets: {
    createOnLogin: 'users-without-wallets',
  },
}
