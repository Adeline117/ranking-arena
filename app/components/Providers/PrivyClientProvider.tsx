'use client';

/**
 * Privy Provider Wrapper
 * 
 * Wraps children with PrivyProvider for one-click login (Google/Email/Wallet).
 * Additive only — does NOT replace existing Supabase Auth.
 */

import { ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { PRIVY_APP_ID, privyConfig } from '@/lib/privy/config';

interface Props {
  children: ReactNode;
}

export default function PrivyClientProvider({ children }: Props) {
  if (!PRIVY_APP_ID) {
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
