'use client';

/**
 * Privy Provider Wrapper
 * 
 * Wraps children with PrivyProvider for Web3 wallet functionality.
 * ⚠️ Will not render Privy features until NEXT_PUBLIC_PRIVY_APP_ID is set.
 * 
 * Usage: Add <PrivyClientProvider> inside the existing Providers component.
 * DO NOT replace existing auth — this is additive only.
 */

import { ReactNode } from 'react';

// Conditionally import Privy to avoid build errors if not installed yet
let PrivyProvider: any = null;
let privyAvailable = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const privy = require('@privy-io/react-auth');
  PrivyProvider = privy.PrivyProvider;
  privyAvailable = true;
} catch {
  // @privy-io/react-auth not installed yet — silently skip
}

import { PRIVY_APP_ID, privyConfig } from '@/lib/privy/config';

interface Props {
  children: ReactNode;
}

export default function PrivyClientProvider({ children }: Props) {
  // Skip if Privy is not installed or not configured
  if (!privyAvailable || !PRIVY_APP_ID) {
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={privyConfig}
    >
      {children}
    </PrivyProvider>
  );
}
