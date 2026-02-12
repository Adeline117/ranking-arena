/**
 * Privy Configuration
 * 
 * ⚠️ Requires NEXT_PUBLIC_PRIVY_APP_ID in .env.local
 * Get it from https://dashboard.privy.io
 * Install: npm install @privy-io/react-auth
 */

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const privyConfig: any = {
  loginMethods: ['google', 'email', 'wallet'],
  appearance: {
    theme: 'dark',
    accentColor: '#7C3AED',
    logo: '/logo.svg',
  },
  embeddedWallets: {
    createOnLogin: 'users-without-wallets',
  },
};
