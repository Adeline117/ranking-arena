/**
 * Privy Configuration
 * 
 * ⚠️ Requires NEXT_PUBLIC_PRIVY_APP_ID in .env.local
 * Get it from https://dashboard.privy.io
 * Install: npm install @privy-io/react-auth
 */

import { BASE_URL } from '@/lib/constants/urls'

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';

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
};
