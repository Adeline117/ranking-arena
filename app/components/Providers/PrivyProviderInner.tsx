'use client';

import { ReactNode } from 'react';
import { PrivyProvider } from '@privy-io/react-auth';
import { PRIVY_APP_ID, privyConfig } from '@/lib/privy/config';

interface Props {
  children: ReactNode;
}

export default function PrivyProviderInner({ children }: Props) {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID!}
      config={privyConfig}
    >
      {children}
    </PrivyProvider>
  );
}
